"""Real Chromium + real isolated API integration for cash and wallet delivery.

Only the local HTML page is fulfilled from disk. All requests to the supplied
localhost API continue to the actual server. External font requests are blocked.
No API response is mocked; no native runtime or external payment provider is used.
"""

import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / 'verification/endtoend-browser-results.json'


def wallet_amount(page):
    value = page.locator('#customerWalletBalance').inner_text()
    match = re.search(r'\d+(?:\.\d+)?', value)
    assert match, f'Wallet amount not displayed: {value}'
    return round(float(match.group()), 2)


def login(page, api, account, results):
    page.locator('#apiBase').fill(api)
    page.locator('#email').fill(account['email'])
    page.locator('#password').fill(account['password'])
    page.locator('button.primary').click()
    try:
        page.wait_for_function('(id) => PROFILE && PROFILE.id === id', arg=account['id'])
        if account['role'] == 'customer':
            page.wait_for_function("document.getElementById('customerWalletBalance').textContent.includes('100.00')")
        else:
            page.wait_for_function("document.getElementById('btnAvail').classList.contains('active')")
    except Exception:
        results['login_failure'] = {
            'role': account['role'], 'page_url': page.url,
            'api_input': page.locator('#apiBase').input_value(),
            'login_error_text': page.locator('#loginErr').inner_text(),
            'profile': page.evaluate('PROFILE ? {id:PROFILE.id,role:PROFILE.role} : null'),
            'api_request_count': len(results['api_requests']),
        }
        screenshot = RESULTS.parent / 'endtoend-login-failure.png'
        page.screenshot(path=str(screenshot), full_page=True)
        results['login_failure']['screenshot'] = str(screenshot)
        raise


def response_for(api, path, method):
    return lambda response: response.url.split('?')[0] == api + path and response.request.method == method


def delivery_flow(customer, driver, api, payment, results):
    customer.locator('#tabNew').click()
    with customer.expect_response(response_for(api, '/orders/estimate', 'GET')) as estimated:
        customer.locator('#vType').select_option('car')
    assert estimated.value.status == 200 and estimated.value.json()['success']
    customer.locator('#paymentMethod').select_option(payment)
    before = wallet_amount(customer)
    with customer.expect_response(response_for(api, '/orders', 'POST')) as observed:
        customer.locator('#confirmOrderBtn').click()
    response = observed.value
    data = response.json()
    assert response.status == 201 and data['success'], f'Create {payment} failed: {data}'
    order_id = data['data']['order_id']
    customer.wait_for_function('(id) => document.getElementById("wbMsg").textContent.includes(id) && !document.getElementById("confirmOrderBtn").disabled', arg=order_id)
    after_create = wallet_amount(customer)
    driver.locator('#driverView .section-title button').click()
    accept = driver.get_by_role('button', name='قبول الطلب', exact=True)
    accept.wait_for(state='visible')
    assert accept.count() == 1, 'Expected exactly one pending order for fixture driver'
    with driver.expect_response(response_for(api, f'/drivers/orders/{order_id}/accept', 'POST')) as accepted:
        accept.click()
    assert accepted.value.status == 200 and accepted.value.json()['success']
    driver.wait_for_function('(id) => ACTIVE_ORDER && ACTIVE_ORDER.id === id', arg=order_id)
    with driver.expect_response(response_for(api, f'/orders/{order_id}/status', 'PATCH')) as started:
        driver.get_by_role('button', name='بدء التوصيل', exact=True).click()
    assert started.value.status == 200 and started.value.json()['success']
    driver.wait_for_function("ACTIVE_ORDER.status === 'in_transit'")
    with driver.expect_response(response_for(api, f'/orders/{order_id}/generate-qr', 'POST')) as generated:
        driver.locator('#generateQRBtn').click()
    assert generated.value.status == 200 and generated.value.json()['success']
    driver.locator('#qrBox code').wait_for(state='visible')
    code = driver.locator('#qrBox code').inner_text().strip()
    assert re.fullmatch(r'[A-F0-9]{32}', code), 'Real QR response did not render a valid delivery token'
    assert driver.locator('#qrBox button').count() == 0, 'Driver QR has a self-confirm control'
    customer.locator('#tabMine').click()
    customer.locator('#myOrdersList .mini-order').filter(has_text=order_id).click()
    customer.wait_for_function('(id) => CURRENT_TRACK && CURRENT_TRACK.id === id && CURRENT_TRACK.status === "in_transit"', arg=order_id)
    assert customer.locator('#deliveryCode').is_visible()
    customer.locator('#deliveryCode').fill(code)
    customer.locator('#receivedDelivery').check()
    if payment == 'cash':
        customer.locator('#cashPaid').check()
    else:
        assert customer.locator('#cashPaid').count() == 0, 'Wallet order asks to acknowledge cash'
    with customer.expect_response(response_for(api, f'/orders/{order_id}/verify-qr', 'POST')) as confirmed:
        customer.locator('#confirmReceiptBtn').click()
    confirmed_data = confirmed.value.json()
    assert confirmed.value.status == 200 and confirmed_data['success'], f'Real QR confirmation failed: {confirmed_data}'
    customer.wait_for_function('(id) => CURRENT_TRACK && CURRENT_TRACK.id === id && CURRENT_TRACK.status === "delivered"', arg=order_id)
    assert customer.locator('#deliveryCode').count() == 0
    with driver.expect_response(response_for(api, f'/orders/{order_id}', 'GET')) as refreshed:
        driver.locator('#refreshDeliveryBtn').click()
    assert refreshed.value.status == 200 and refreshed.value.json()['data']['status'] == 'delivered'
    driver.wait_for_function("ACTIVE_ORDER === null && document.getElementById('btnAvail').classList.contains('active')")
    driver.wait_for_function("!document.getElementById('driverFeed').textContent.includes('جارِ التحميل')")
    assert driver.locator('#activeOrderBox').inner_text().strip(), 'Driver delivery completion not displayed'
    after_delivery = wallet_amount(customer)
    assert after_delivery == after_create, 'Displayed wallet changed again during delivery'
    if payment == 'cash':
        assert before == 100.00 and after_create == 100.00, 'Cash delivery debited the customer wallet'
    else:
        assert before == 100.00 and 0 <= after_create < before, 'Wallet creation did not debit the customer wallet'
    screenshot = RESULTS.parent / f'endtoend-{payment}-delivered.png'
    customer.screenshot(path=str(screenshot), full_page=True)
    evidence = {
        'order_id': order_id, 'payment_method': payment, 'status': 'delivered',
        'wallet_before_creation': before, 'wallet_after_creation': after_create,
        'wallet_after_delivery': after_delivery, 'customer_confirmed': True,
        'driver_active_cleared': True, 'screenshot': str(screenshot),
    }
    results['flows'].append(evidence)
    print(json.dumps({'flow': payment, 'order_id': order_id, 'status': 'passed'}, ensure_ascii=False), flush=True)


def main(config_path):
    config = json.loads(Path(config_path).read_text())
    base = config['base'].rstrip('/')
    assert urlparse(base).hostname in {'localhost', '127.0.0.1', '::1'}, 'Integration requires a local isolated API'
    api = base + '/v1'
    page_url = base + '/kntr-app.html'
    source = ROOT / 'kntr-package/frontend/kntr-app.html'
    results = {
        'verification': 'Actual Chromium connected to real isolated KNTR API and PostgreSQL; API responses are not mocked',
        'timestamp_utc': datetime.now(timezone.utc).isoformat(),
        'source': str(source), 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'api_base': api, 'page_url': page_url, 'actualBackend': True, 'apiMocked': False, 'native': False,
        'limitations': 'Covers full HTML cash/wallet delivery flows with the HTML injected on the local API origin. No cross-origin deployment, Android/iOS runtime, physical cash transfer, external payment provider or production service is verified.',
        'flows': [], 'api_requests': [], 'api_responses': [], 'request_failures': [],
        'console': [], 'blocked_external_urls': [], 'page_errors': [], 'dialogs': [],
    }
    browser = None
    try:
        with sync_playwright() as playwright:
            chromium = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
            if not chromium:
                raise RuntimeError('Install Chromium or set CHROMIUM_PATH')
            browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
            results['browser_version'] = browser.version
            pages = []
            for role in ['customer', 'driver']:
                context = browser.new_context(viewport={'width': 430, 'height': 932}, service_workers='block')
                def route_request(route):
                    if route.request.url == page_url:
                        route.fulfill(status=200, content_type='text/html', body=source.read_text())
                    elif route.request.url.startswith(api + '/'):
                        route.continue_()
                    else:
                        results['blocked_external_urls'].append(route.request.url)
                        route.abort()
                context.route('**/*', route_request)
                page = context.new_page()
                page.set_default_timeout(10000)
                page.on('pageerror', lambda error, role=role: results['page_errors'].append({'role': role, 'error': str(error)}))
                def observe_request(request, role=role):
                    if request.url.startswith(api + '/'):
                        results['api_requests'].append({'role': role, 'url': request.url, 'method': request.method})
                page.on('request', observe_request)
                page.on('requestfailed', lambda request, role=role: results['request_failures'].append({
                    'role': role, 'url': request.url, 'method': request.method, 'failure': request.failure,
                }))
                page.on('console', lambda message, role=role: results['console'].append({
                    'role': role, 'type': message.type, 'text': message.text[:1000],
                }))
                def observe_response(response, role=role):
                    if response.url.startswith(api + '/'):
                        results['api_responses'].append({'role': role, 'path': urlparse(response.url).path, 'method': response.request.method, 'status': response.status})
                page.on('response', observe_response)
                def accept_dialog(dialog, role=role):
                    results['dialogs'].append({'role': role, 'message': dialog.message})
                    dialog.accept()
                page.on('dialog', accept_dialog)
                page.goto(page_url, wait_until='load')
                login(page, api, {**config[role], 'role': role}, results)
                pages.append(page)
            customer, driver = pages
            delivery_flow(customer, driver, api, 'cash', results)
            delivery_flow(customer, driver, api, 'wallet', results)
            assert not results['page_errors'], f'Uncaught frontend errors: {results["page_errors"]}'
            assert not results['dialogs'], f'Unexpected UI error dialogs: {results["dialogs"]}'
            unexpected_errors = [r for r in results['api_responses'] if r['status'] >= 400 and not (
                r['path'] == '/v1/drivers/orders' and r['status'] in [400, 403]
            )]
            assert not unexpected_errors, f'Real API returned an unexpected error: {unexpected_errors}'
            browser.close()
            browser = None
        results['summary'] = {'success': True, 'real_delivery_flows': 2, 'actualBackend': True, 'apiMocked': False, 'native': False}
    except Exception as exc:
        results['error'] = str(exc)
        results['summary'] = {'success': False, 'real_delivery_flows': len(results['flows']), 'actualBackend': True, 'apiMocked': False, 'native': False}
        print(str(exc), file=sys.stderr, flush=True)
    finally:
        RESULTS.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'results': str(RESULTS), 'summary': results['summary']}, ensure_ascii=False), flush=True)
    return 0 if results['summary']['success'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
