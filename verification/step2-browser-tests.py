"""Actual Chromium checks of the delivery UI with ALL API responses mocked.

Source HTML is read-only. HTTP(S) traffic is intercepted; external origins are
aborted. These checks are frontend evidence, not backend or native-app evidence.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [
    ROOT / 'kntr-package/frontend/kntr-app.html',
    ROOT / 'kntr-mobile/www/index.html',
    ROOT / 'kntr-mobile/android/app/src/main/assets/public/index.html',
    ROOT / 'kntr-mobile/ios/App/App/public/index.html',
]
RESULTS = ROOT / 'verification/step2-browser-results.json'
API = 'http://127.0.0.1:38882/v1'
PAGE_URL = 'http://127.0.0.1:38881/kntr-app.html'
ORDER_ID = 'ORD-00001'
OTHER_ORDER_ID = 'ORD-00002'
CODE = 'E' * 32
QR_PAYLOAD = f'QUICKSHIP:{ORDER_ID}:{CODE}'
OWNER_ID = 'MOCK-CUSTOMER-A'
DRIVER_ID = 'MOCK-DRIVER-A'
EXPIRED_MESSAGE = 'انتهت صلاحية رمز التسليم التجريبي'
IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII='


class MockAPI:
    def __init__(self, source, *, status='in_transit', payment='cash', owner=OWNER_ID, expired=False):
        self.source = source
        self.requests = []
        self.blocked_external_urls = []
        self.unexpected_routes = []
        self.expired = expired
        self.users = {
            'owner@example.ly': {'id': OWNER_ID, 'role': 'customer', 'full_name_ar': 'عميل تجريبي'},
            'driver@example.ly': {'id': DRIVER_ID, 'role': 'driver', 'full_name_ar': 'سائق تجريبي'},
        }
        self.order = {
            'id': ORDER_ID, 'status': status, 'customer_id': owner,
            'driver_id': DRIVER_ID if status != 'pending' else None,
            'pickup_address': 'استلام تجريبي', 'dropoff_address': 'تسليم تجريبي',
            'distance': 4.2, 'vehicle_type': 'motorcycle', 'priority': 'standard',
            'final_price': '15.00', 'payment_method': payment, 'payment_status': 'pending', 'rating': None,
        }

    def route(self, route):
        request = route.request
        if request.url == PAGE_URL:
            route.fulfill(status=200, content_type='text/html', body=self.source.read_text())
            return
        if not request.url.startswith(API + '/'):
            self.blocked_external_urls.append(request.url)
            route.abort()
            return
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        }
        if request.method == 'OPTIONS':
            route.fulfill(status=204, headers=headers)
            return
        path = urlparse(request.url).path.removeprefix('/v1')
        body = request.post_data_json if request.post_data else None
        self.requests.append({'method': request.method, 'path': path, 'body': body})
        data = None
        status = 200
        success = True
        error = None
        if path == '/auth/login':
            user = self.users[body['email']]
            data = {'user': user, 'tokens': {'access_token': 'MOCK-TOKEN-' + user['id']}}
        elif path == '/auth/me':
            token = request.headers.get('authorization', '')
            if token == 'Bearer MOCK-TOKEN-' + OWNER_ID:
                data = {'id': OWNER_ID, 'role': 'customer', 'wallet_balance': '100.00'}
            else:
                data = {
                    'id': DRIVER_ID, 'role': 'driver', 'driver_status': 'approved',
                    'availability': 'available' if self.order['status'] == 'pending' else 'busy',
                    'rating': 5, 'total_trips': 0, 'total_earnings': '0.00', 'wallet_balance': '0.00',
                }
        elif path == '/orders/estimate':
            data = {'distance': 4.2, 'basePrice': 12, 'customerDiscount': 0, 'vatAmount': 3, 'finalPrice': 15}
        elif path == '/drivers/orders':
            data = [self.order.copy()] if self.order['status'] == 'pending' else []
        elif path == '/drivers/orders/' + ORDER_ID + '/accept':
            self.order.update(status='accepted', driver_id=DRIVER_ID)
            data = {'order_id': ORDER_ID, 'status': 'accepted'}
        elif path == '/orders/' + ORDER_ID + '/status':
            self.order['status'] = body['status']
            data = {'order_id': ORDER_ID, 'status': self.order['status']}
        elif path == '/orders/' + ORDER_ID + '/generate-qr':
            data = {
                'qr_code': CODE, 'qr_payload': QR_PAYLOAD, 'qr_image': IMAGE,
                'expires_at': '2099-01-01T00:00:00.000Z', 'qr_expires_at': '2099-01-01T00:00:00.000Z',
                'order_id': ORDER_ID,
            }
        elif path == '/orders/' + ORDER_ID + '/verify-qr':
            if self.expired:
                status = 400
                success = False
                error = {'code': 'QR_EXPIRED', 'message': EXPIRED_MESSAGE}
            else:
                self.order['status'] = 'delivered'
                data = {'order_id': ORDER_ID, 'status': 'delivered'}
        elif path == '/orders/' + ORDER_ID:
            data = self.order.copy()
        elif path == '/orders':
            data = [self.order.copy()]
        else:
            self.unexpected_routes.append({'method': request.method, 'path': path})
            success = False
            status = 404
            error = {'code': 'MOCK_UNEXPECTED_ROUTE', 'message': path}
        route.fulfill(status=status, headers=headers, content_type='application/json', body=json.dumps({
            'success': success, 'data': data, 'error': error,
        }, ensure_ascii=False))

    def verifies(self):
        return [r for r in self.requests if r['path'].endswith('/verify-qr')]


def login(page, role='customer'):
    email = 'driver@example.ly' if role == 'driver' else 'owner@example.ly'
    page.locator('#apiBase').fill(API)
    page.locator('#email').fill(email)
    page.locator('#password').fill('MockPassw0rd123')
    page.locator('button.primary').click()
    page.wait_for_function('(role) => PROFILE && PROFILE.role === role', arg=role)


def open_customer_order(page):
    login(page)
    page.locator('#tabMine').click()
    page.locator('#myOrdersList .mini-order').click()
    page.wait_for_function('(id) => CURRENT_TRACK && CURRENT_TRACK.id === id', arg=ORDER_ID)


def submit(page):
    button = page.locator('#confirmReceiptBtn')
    assert button.count() == 1, 'Customer receipt-confirm button missing'
    if button.is_enabled():
        button.click()
    page.wait_for_timeout(100)


def driver_code_only(page, mock, dialogs):
    login(page, 'driver')
    page.get_by_role('button', name='قبول الطلب', exact=True).click()
    page.wait_for_function('(id) => ACTIVE_ORDER && ACTIVE_ORDER.id === id', arg=ORDER_ID)
    page.get_by_role('button', name='بدء التوصيل', exact=True).click()
    page.wait_for_function("ACTIVE_ORDER.status === 'in_transit'")
    page.locator('#generateQRBtn').click()
    page.wait_for_function('(code) => document.getElementById("qrBox").textContent.includes(code)', arg=CODE)
    box = page.locator('#qrBox')
    assert box.locator('img').count() == 1, 'Driver QR image missing'
    assert box.get_by_role('button', name=re.compile('تأكيد.*التسليم|تأكيد.*الاستلام')).count() == 0, 'Driver can self-confirm'
    assert page.evaluate('typeof confirmDelivery') == 'undefined', 'Legacy driver self-confirm function retained'
    before = len([r for r in mock.requests if r['path'] == '/orders/' + ORDER_ID])
    page.locator('#refreshDeliveryBtn').click()
    page.wait_for_timeout(100)
    after = len([r for r in mock.requests if r['path'] == '/orders/' + ORDER_ID])
    assert after > before, 'Driver delivery refresh did not read server state'
    assert not mock.verifies(), 'Driver screen submitted verify-qr'
    return {'driver_self_confirm_absent': True, 'qr_visible': True, 'server_refresh_requested': True}


def customer_ack_gates(page, mock, dialogs):
    open_customer_order(page)
    assert page.locator('#deliveryCode').is_visible()
    assert page.locator('#receivedDelivery').is_visible()
    assert page.locator('#cashPaid').is_visible()
    assert '15' in page.locator('#trackResult').inner_text(), 'Cash amount not shown'
    page.locator('#deliveryCode').fill(CODE)
    submit(page)
    assert not mock.verifies(), 'Receipt checkbox missing but request submitted'
    page.locator('#receivedDelivery').check()
    submit(page)
    assert not mock.verifies(), 'Cash checkbox missing but request submitted'
    page.locator('#cashPaid').check()
    page.locator('#receivedDelivery').uncheck()
    submit(page)
    assert not mock.verifies(), 'Cash alone allowed confirmation without receipt'
    return {'receipt_and_cash_required': True, 'verify_requests_blocked': 3}


def customer_valid_code(page, mock, dialogs, payload=False):
    open_customer_order(page)
    page.locator('#deliveryCode').fill(QR_PAYLOAD if payload else CODE.lower())
    page.locator('#receivedDelivery').check()
    if mock.order['payment_method'] == 'cash':
        page.locator('#cashPaid').check()
    before = len(mock.requests)
    submit(page)
    page.wait_for_function("CURRENT_TRACK && CURRENT_TRACK.status === 'delivered'")
    verifies = mock.verifies()
    assert len(verifies) == 1, 'Valid confirmation should submit exactly once'
    body = verifies[0]['body']
    assert body['qr_code'] == CODE, 'Raw/payload code was not parsed to 32-char token'
    assert body['received'] is True, 'Receipt acknowledgement missing in request'
    assert body['cash_paid'] is (mock.order['payment_method'] == 'cash'), 'Cash acknowledgement differs from payment method'
    assert any(r['path'] == '/orders/' + ORDER_ID for r in mock.requests[before:]), 'Confirmed tracking was not reloaded'
    assert page.locator('#deliveryCode').count() == 0, 'Receipt form retained after delivered state'
    return {'input': 'order_bound_qr_payload' if payload else 'raw_code', 'post_body': body, 'tracking_refreshed': True}


def customer_foreign_payload(page, mock, dialogs):
    open_customer_order(page)
    page.locator('#deliveryCode').fill(f'QUICKSHIP:{OTHER_ORDER_ID}:{CODE}')
    page.locator('#receivedDelivery').check()
    page.locator('#cashPaid').check()
    submit(page)
    assert not mock.verifies(), 'A QR payload from another order reached verify API'
    assert page.locator('#deliveryConfirmMsg').inner_text().strip(), 'Foreign-order rejection not shown'
    assert page.evaluate('CURRENT_TRACK.status') == 'in_transit'
    return {'different_order_payload_blocked_without_fetch': True}


def expired_error(page, mock, dialogs):
    open_customer_order(page)
    page.locator('#deliveryCode').fill(CODE)
    page.locator('#receivedDelivery').check()
    page.locator('#cashPaid').check()
    submit(page)
    page.wait_for_function('(message) => document.getElementById("deliveryConfirmMsg").textContent.includes(message)', arg=EXPIRED_MESSAGE)
    assert len(mock.verifies()) == 1
    assert page.evaluate('CURRENT_TRACK.status') == 'in_transit', 'Expired QR changed local status to delivered'
    assert page.locator('#deliveryCode').is_visible()
    assert not any('تم تأكيد' in d or 'تم التسليم' in d for d in dialogs), 'Expired response reported silent success'
    return {'server_error_visible': True, 'status_unchanged': True}


def form_absent(page, mock, dialogs):
    open_customer_order(page)
    assert page.locator('#deliveryCode').count() == 0, 'Receipt confirmation exposed for non-owner or non-transit order'
    assert page.locator('#confirmReceiptBtn').count() == 0
    assert not mock.verifies()
    return {'order_status': mock.order['status'], 'owner': mock.order['customer_id'], 'form_absent': True}


def noncash_receipt(page, mock, dialogs):
    open_customer_order(page)
    assert page.locator('#deliveryCode').is_visible()
    assert page.locator('#cashPaid').count() == 0, 'Noncash order asks for cash payment'
    page.locator('#deliveryCode').fill(CODE)
    submit(page)
    assert not mock.verifies(), 'Noncash confirmation bypassed receipt acknowledgement'
    page.locator('#receivedDelivery').check()
    submit(page)
    page.wait_for_function("CURRENT_TRACK.status === 'delivered'")
    assert len(mock.verifies()) == 1
    return {'cash_checkbox_absent': True, 'receipt_ack_required': True, 'post_body': mock.verifies()[0]['body']}


def scenario(browser, source, name, action, options):
    context = browser.new_context(viewport={'width': 430, 'height': 932}, service_workers='block')
    mock = MockAPI(source, **options)
    context.route('**/*', mock.route)
    page = context.new_page()
    errors = []
    dialogs = []
    page.on('pageerror', lambda exc: errors.append(str(exc)))
    def accept_dialog(dialog):
        dialogs.append(dialog.message)
        dialog.accept()
    page.on('dialog', accept_dialog)
    result = {'source': str(source), 'name': name}
    try:
        page.goto(PAGE_URL, wait_until='load')
        result['evidence'] = action(page, mock, dialogs)
        assert not errors, f'Browser JavaScript errors: {errors}'
        assert not mock.unexpected_routes, f'Unexpected mocked API routes: {mock.unexpected_routes}'
        result['status'] = 'passed'
    except Exception as exc:
        result['status'] = 'failed'
        result['error'] = str(exc)
        screenshot = RESULTS.parent / f'step2-browser-failure-{hashlib.sha256((str(source)+name).encode()).hexdigest()[:12]}.png'
        page.screenshot(path=str(screenshot), full_page=True)
        result['screenshot'] = str(screenshot)
    finally:
        result.update(mock_api_requests=mock.requests, blocked_external_urls=mock.blocked_external_urls, page_errors=errors, dialogs=dialogs)
        context.close()
    print(json.dumps({'source': str(source), 'name': name, 'status': result['status'], 'error': result.get('error')}, ensure_ascii=False), flush=True)
    return result


def check_script_syntax(source):
    scripts = re.findall(r'<script\b[^>]*>(.*?)</script>', source.read_text(), flags=re.DOTALL | re.IGNORECASE)
    assert scripts, f'No inline scripts in {source}'
    for index, script in enumerate(scripts):
        checked = subprocess.run(['node', '--check'], input=script, text=True, capture_output=True)
        assert checked.returncode == 0, f'{source}, inline script {index}: {checked.stderr}'
    return {'source': str(source), 'name': 'Inline JavaScript syntax', 'status': 'passed', 'evidence': {'script_count': len(scripts)}}


def main():
    results = {
        'verification': 'Actual Chromium frontend; ALL API responses MOCKED',
        'limitations': 'No backend, deployed service, Android or iOS runtime verification; native copies only tested as browser HTML.',
        'network': 'Mock localhost page/API routes fulfilled in Playwright; every external request aborted; no external network.',
        'timestamp_utc': datetime.now(timezone.utc).isoformat(),
        'sources': [{'path': str(s), 'sha256': hashlib.sha256(s.read_bytes()).hexdigest()} for s in SOURCES],
        'checks': [],
    }
    scenarios = [
        ('Driver generates code and refreshes without self confirmation', driver_code_only, {'status': 'pending'}),
        ('Owner receipt and cash acknowledgement block incomplete confirmation', customer_ack_gates, {}),
        ('Owner raw QR token confirms then reloads tracking', customer_valid_code, {}),
        ('Owner order-bound QR payload is parsed and confirms', lambda p, m, d: customer_valid_code(p, m, d, True), {}),
        ('Different-order QR payload is rejected before API request', customer_foreign_payload, {}),
        ('Expired server QR response remains visible with transit status', expired_error, {'expired': True}),
        ('Noncash confirmation requires receipt without cash checkbox', noncash_receipt, {'payment': 'wallet'}),
        ('Another customer order has no receipt form', form_absent, {'owner': 'MOCK-CUSTOMER-B'}),
        ('Pending order has no receipt form', form_absent, {'status': 'pending'}),
        ('Accepted order has no receipt form', form_absent, {'status': 'accepted'}),
        ('Delivered order has no receipt form', form_absent, {'status': 'delivered'}),
    ]
    with sync_playwright() as playwright:
        chromium = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        if not chromium:
            raise RuntimeError('Install Chromium or set CHROMIUM_PATH to its executable')
        browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
        results['browser_version'] = browser.version
        for source in SOURCES:
            try:
                results['checks'].append(check_script_syntax(source))
            except Exception as exc:
                results['checks'].append({'source': str(source), 'name': 'Inline JavaScript syntax', 'status': 'failed', 'error': str(exc)})
            for name, action, options in scenarios:
                results['checks'].append(scenario(browser, source, name, action, options))
        browser.close()
    results['summary'] = {
        'passed': sum(c['status'] == 'passed' for c in results['checks']),
        'failed': sum(c['status'] == 'failed' for c in results['checks']),
        'success': all(c['status'] == 'passed' for c in results['checks']),
        'api_mocked': True,
        'native_runtime_tested': False,
    }
    RESULTS.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'results': str(RESULTS), 'summary': results['summary']}, ensure_ascii=False), flush=True)
    return 0 if results['summary']['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
