"""Payment UI checks in real Chromium with ALL API responses mocked.

The HTML sources are read-only. Every external HTTP(S) request is aborted.
This verifies frontend behavior only, not payment providers, backend money
movement, or Android/iOS native runtimes. The root runner owns execution.
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
RESULTS = ROOT / 'verification/step3-browser-results.json'
API = 'http://127.0.0.1:38882/v1'
PAGE_URL = 'http://127.0.0.1:38881/kntr-app.html'
OWNER_ID = 'MOCK-CUSTOMER-A'
DRIVER_ID = 'MOCK-DRIVER-A'
SERVER_PRICE = 15.50
INSUFFICIENT_MESSAGE = 'رصيد المحفظة غير كافٍ (تجريبي)'


class MockAPI:
    def __init__(self, source, *, balance=100.00, delayed=False, abort_create=False, logout_failure=None, private_order=False):
        self.source = source
        self.balance = balance
        self.delayed = delayed
        self.abort_create = abort_create
        self.logout_failure = logout_failure
        self.private_order = private_order
        self.requests = []
        self.blocked_external_urls = []
        self.unexpected_routes = []
        self.pending_creates = []
        self.created_orders = []
        self.users = {
            'owner@example.ly': {'id': OWNER_ID, 'role': 'customer', 'full_name_ar': 'عميل تجريبي'},
            'driver@example.ly': {'id': DRIVER_ID, 'role': 'driver', 'full_name_ar': 'سائق تجريبي'},
        }

    @staticmethod
    def reply(route, *, data=None, status=200, success=True, error=None):
        headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        }
        if status == 204:
            route.fulfill(status=status, headers=headers)
            return
        route.fulfill(status=status, headers=headers, content_type='application/json', body=json.dumps({
            'success': success, 'data': data, 'error': error,
        }, ensure_ascii=False))

    def finish_create(self, route, body):
        if body['payment_method'] == 'wallet' and self.balance < SERVER_PRICE:
            self.reply(route, status=400, success=False, error={
                'code': 'INSUFFICIENT_BALANCE', 'message': INSUFFICIENT_MESSAGE,
            })
            return
        if body['payment_method'] == 'wallet':
            self.balance = round(self.balance - SERVER_PRICE, 2)
        order_id = f'ORD-{len(self.created_orders) + 1:05d}'
        self.created_orders.append({'id': order_id, 'payment_method': body['payment_method']})
        self.reply(route, status=201, data={
            'order_id': order_id, 'status': 'pending', 'final_price': SERVER_PRICE,
            'payment_method': body['payment_method'],
            'payment_status': 'paid' if body['payment_method'] == 'wallet' else 'pending',
        })

    def release_creates(self):
        pending, self.pending_creates = self.pending_creates, []
        for route, body in pending:
            self.finish_create(route, body)

    def route(self, route):
        request = route.request
        if request.url == PAGE_URL:
            route.fulfill(status=200, content_type='text/html', body=self.source.read_text())
            return
        if not request.url.startswith(API + '/'):
            self.blocked_external_urls.append(request.url)
            route.abort()
            return
        if request.method == 'OPTIONS':
            self.reply(route, status=204)
            return
        path = urlparse(request.url).path.removeprefix('/v1')
        body = request.post_data_json if request.post_data else None
        self.requests.append({'method': request.method, 'path': path, 'body': body,
                              'authorization': request.headers.get('authorization')})
        if path == '/auth/login':
            user = self.users[body['email']]
            self.reply(route, data={'user': user, 'tokens': {'access_token': 'MOCK-TOKEN-' + user['id']}})
        elif path == '/auth/logout':
            if self.logout_failure == 'network':
                route.abort('connectionfailed')
            elif self.logout_failure == 'server':
                self.reply(route, status=503, success=False, error={
                    'code': 'MOCK_UNAVAILABLE', 'message': 'تعذّر إنهاء جلسة الخادم التجريبية',
                })
            else:
                self.reply(route, data=None)
        elif path == '/auth/me':
            token = request.headers.get('authorization', '')
            if token == 'Bearer MOCK-TOKEN-' + OWNER_ID:
                self.reply(route, data={'id': OWNER_ID, 'role': 'customer', 'wallet_balance': f'{self.balance:.2f}'})
            elif token == 'Bearer MOCK-TOKEN-' + DRIVER_ID:
                self.reply(route, data={
                    'id': DRIVER_ID, 'role': 'driver', 'driver_status': 'approved', 'availability': 'available',
                    'rating': 5, 'total_trips': 4, 'total_earnings': '123.45', 'wallet_balance': '7.00',
                })
            else:
                self.unexpected_routes.append({'path': path, 'error': 'Unknown mock token'})
                self.reply(route, status=401, success=False, error={'code': 'UNAUTHORIZED', 'message': 'Mock token missing'})
        elif path == '/orders/estimate':
            # Distinct server charge proves balance refresh uses the authoritative mock API.
            self.reply(route, data={'distance': 4.2, 'basePrice': 12, 'customerDiscount': 0, 'vatAmount': 3, 'finalPrice': 15})
        elif path == '/orders' and request.method == 'POST':
            if self.abort_create:
                self.abort_create = False
                route.abort('connectionfailed')
            elif self.delayed:
                self.pending_creates.append((route, body))
            else:
                self.finish_create(route, body)
        elif path == '/orders' and self.private_order:
            self.reply(route, data=[self.order_fixture()])
        elif path == '/orders/ORD-00001' and self.private_order:
            self.reply(route, data=self.order_fixture())
        elif path == '/orders' or path == '/drivers/orders':
            self.reply(route, data=[])
        else:
            self.unexpected_routes.append({'method': request.method, 'path': path})
            self.reply(route, status=404, success=False, error={'code': 'MOCK_UNEXPECTED_ROUTE', 'message': path})

    def creates(self):
        return [r for r in self.requests if r['path'] == '/orders' and r['method'] == 'POST']

    @staticmethod
    def order_fixture():
        return {
            'id': 'ORD-00001', 'status': 'in_transit', 'customer_id': OWNER_ID, 'driver_id': DRIVER_ID,
            'pickup_address': 'استلام خاص تجريبي', 'dropoff_address': 'تسليم خاص تجريبي',
            'final_price': '15.50', 'payment_method': 'cash', 'rating': None,
        }


def wait_balance(page, amount):
    page.wait_for_function(r'''(amount) => {
      const el = document.getElementById('customerWalletBalance');
      const match = el && el.textContent.match(/[0-9]+(?:\.[0-9]+)?/);
      return match && Number(match[0]) === amount;
    }''', arg=amount)


def login(page, role='customer', balance=100.00):
    email = 'driver@example.ly' if role == 'driver' else 'owner@example.ly'
    page.locator('#apiBase').fill(API)
    page.locator('#email').fill(email)
    page.locator('#password').fill('MockPassw0rd123')
    page.locator('button.primary').click()
    page.wait_for_function('(role) => PROFILE && PROFILE.role === role', arg=role)
    if role == 'customer':
        wait_balance(page, balance)
        page.wait_for_function("document.getElementById('wbTotal').textContent.includes('15')")


def wait_created(page):
    page.wait_for_function("document.getElementById('wbMsg').textContent.includes('ORD-00001')")
    page.wait_for_function("!document.getElementById('confirmOrderBtn').disabled")


def cash_selection(page, mock, dialogs):
    login(page, balance=mock.balance)
    selector = page.locator('#paymentMethod')
    values = selector.locator('option').evaluate_all('(options) => options.map(option => option.value)')
    assert set(values) == {'cash', 'wallet'}, f'Unsupported payment choices: {values}'
    assert selector.input_value() == 'cash', 'Cash is not the default choice'
    page.locator('#confirmOrderBtn').click()
    wait_created(page)
    assert len(mock.creates()) == 1
    assert mock.creates()[0]['body']['payment_method'] == 'cash'
    assert len(mock.created_orders) == 1
    wait_balance(page, 100.00)
    return {'default_cash_sent': True, 'wallet_balance_unchanged': True, 'available_methods': values}


def wallet_selection(page, mock, dialogs):
    login(page, balance=mock.balance)
    page.locator('#paymentMethod').select_option('wallet')
    before = len(mock.requests)
    page.locator('#confirmOrderBtn').click()
    wait_created(page)
    wait_balance(page, 84.50)
    assert len(mock.creates()) == 1
    assert mock.creates()[0]['body']['payment_method'] == 'wallet'
    assert len(mock.created_orders) == 1
    after = mock.requests[before:]
    assert any(r['path'] == '/auth/me' and r['method'] == 'GET' for r in after), 'Wallet was not reloaded after creation'
    assert after[0]['path'] == '/orders' and after[0]['method'] == 'POST', 'Unexpected request before creation'
    return {'wallet_sent': True, 'displayed_balance': 84.50, 'server_charge': SERVER_PRICE, 'authoritative_wallet_refresh': True}


def insufficient_funds(page, mock, dialogs):
    login(page, balance=mock.balance)
    page.locator('#paymentMethod').select_option('wallet')
    page.locator('#confirmOrderBtn').click()
    page.wait_for_function('(message) => document.getElementById("wbMsg").textContent.includes(message)', arg=INSUFFICIENT_MESSAGE)
    assert len(mock.creates()) == 1, 'Insufficient-funds server response was not exercised'
    assert not mock.created_orders
    assert 'تم إنشاء' not in page.locator('#wbMsg').inner_text(), 'Insufficient funds reported order creation'
    assert page.locator('#confirmOrderBtn').is_enabled(), 'Failed order left create button busy'
    wait_balance(page, 2.00)
    return {'server_error_visible': True, 'no_fake_order_created': True, 'button_reenabled': True}


def duplicate_pending(page, mock, dialogs):
    login(page, balance=mock.balance)
    page.locator('#paymentMethod').select_option('wallet')
    # Two real button activations plus a duplicate handler call exercise both UI and handler guards.
    page.evaluate('''() => {
      const button = document.getElementById('confirmOrderBtn');
      button.click(); button.click(); createOrder();
    }''')
    page.wait_for_timeout(150)
    assert len(mock.creates()) == 1, 'Duplicate pending submit generated additional order POSTs'
    assert len(mock.pending_creates) == 1
    assert page.locator('#confirmOrderBtn').is_disabled(), 'Pending order button remains enabled'
    assert not mock.created_orders
    mock.release_creates()
    wait_created(page)
    wait_balance(page, 84.50)
    assert len(mock.creates()) == 1 and len(mock.created_orders) == 1
    return {'pending_submit_attempts': 3, 'order_posts': 1, 'button_disabled_while_pending': True, 'one_order_after_release': True}


def network_failure_retry(page, mock, dialogs):
    login(page, balance=mock.balance)
    page.locator('#confirmOrderBtn').click()
    page.wait_for_function("document.getElementById('wbMsg').textContent.trim().length > 0 && !document.getElementById('confirmOrderBtn').disabled")
    error = page.locator('#wbMsg').inner_text()
    assert 'تم إنشاء' not in error and 'ORD-' not in error, 'Failed network request reported creation'
    assert len(mock.creates()) == 1 and not mock.created_orders
    page.locator('#confirmOrderBtn').click()
    wait_created(page)
    assert len(mock.creates()) == 2 and len(mock.created_orders) == 1, 'Failure did not clear busy state for retry'
    return {'network_error_visible': error, 'busy_state_cleared': True, 'retry_created_one_order': True}


def driver_earnings(page, mock, dialogs):
    login(page, 'driver')
    page.wait_for_function("document.getElementById('mEarnings').textContent.includes('123.45')")
    text = page.locator('#mEarnings').inner_text()
    assert '7.00' not in text, 'Driver display uses spendable wallet instead of accrued earnings'
    assert 'إجمالي الأرباح' in page.locator('#driverView').inner_text(), 'Earnings label is ambiguous'
    return {'accrued_earnings_displayed': '123.45', 'distinct_wallet_balance': '7.00'}


def assert_local_logout(page):
    page.wait_for_function('''() => TOKEN === null && PROFILE === null &&
      ACTIVE_ORDER === null && CURRENT_TRACK === null &&
      !document.getElementById('loginWrap').classList.contains('hidden')''')
    assert page.locator('#loginWrap').is_visible()
    assert not page.locator('#appShell').is_visible()
    for selector in ['#myOrdersList', '#trackResult', '#activeOrderBox', '#driverFeed']:
        assert not page.locator(selector).inner_html().strip(), f'Private DOM retained after logout: {selector}'
    assert page.locator('#paymentMethod').input_value() == 'cash', 'Payment selection survived logout'
    assert '100' not in page.locator('#customerWalletBalance').inner_text(), 'Private wallet balance retained after logout'


def logout_state(page, mock, dialogs):
    login(page, balance=mock.balance)
    page.locator('#paymentMethod').select_option('wallet')
    page.locator('#tabMine').click()
    page.locator('#myOrdersList .mini-order').click()
    page.wait_for_function("CURRENT_TRACK && CURRENT_TRACK.id === 'ORD-00001'")
    assert page.locator('#trackResult').inner_text().strip(), 'Private order fixture not rendered'
    page.get_by_role('button', name='خروج', exact=True).click()
    assert_local_logout(page)
    page.wait_for_timeout(150)
    calls = [r for r in mock.requests if r['path'] == '/auth/logout']
    assert len(calls) == 1 and calls[0]['method'] == 'POST', 'Logout did not call server exactly once'
    assert calls[0]['authorization'] == 'Bearer MOCK-TOKEN-' + OWNER_ID, 'Logout request lost captured authorization'
    warning = page.locator('#loginErr').inner_text()
    if mock.logout_failure:
        assert warning.strip(), 'Failed server logout omitted local-only warning'
        assert 'تعذ' in warning, 'Failed server logout did not explain failure'
        assert any(term in warning for term in ['الخادم', 'السيرفر', 'الجلسة', 'جلسة']), 'Warning does not distinguish server session'
    else:
        assert not warning.strip(), 'Successful server logout shows a failure warning'
    return {'server_logout_called': True, 'authorization_preserved': True, 'private_state_and_dom_cleared': True,
            'failure_mode': mock.logout_failure, 'warning': warning}


def pending_create_logout(page, mock, dialogs):
    login(page, balance=mock.balance)
    page.locator('#paymentMethod').select_option('wallet')
    page.locator('#confirmOrderBtn').click()
    page.wait_for_timeout(100)
    assert len(mock.pending_creates) == 1, 'Delayed create fixture did not start'
    page.get_by_role('button', name='خروج', exact=True).click()
    assert_local_logout(page)
    page.wait_for_timeout(100)
    after_logout = len(mock.requests)
    mock.release_creates()
    page.wait_for_timeout(200)
    assert_local_logout(page)
    assert not page.locator('#wbMsg').inner_text().strip(), 'Late create callback restored private order status after logout'
    assert not any(r['path'] == '/auth/me' for r in mock.requests[after_logout:]), 'Late create callback fetched private profile after logout'
    return {'late_create_callback_did_not_restore_private_ui': True, 'login_remained_visible': True}


def check_script_syntax(source):
    scripts = re.findall(r'<script\b[^>]*>(.*?)</script>', source.read_text(), flags=re.DOTALL | re.IGNORECASE)
    assert scripts, f'No inline scripts in {source}'
    for index, script in enumerate(scripts):
        checked = subprocess.run(['node', '--check'], input=script, text=True, capture_output=True)
        assert checked.returncode == 0, f'{source}, inline script {index}: {checked.stderr}'
    return {'source': str(source), 'name': 'Inline JavaScript syntax', 'status': 'passed', 'evidence': {'script_count': len(scripts)}}


def scenario(browser, source, name, action, options):
    context = browser.new_context(viewport={'width': 430, 'height': 932}, service_workers='block')
    mock = MockAPI(source, **options)
    context.route('**/*', mock.route)
    page = context.new_page()
    errors, dialogs = [], []
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
        screenshot = RESULTS.parent / f'step3-browser-failure-{hashlib.sha256((str(source)+name).encode()).hexdigest()[:12]}.png'
        page.screenshot(path=str(screenshot), full_page=True)
        result['screenshot'] = str(screenshot)
    finally:
        result.update(mock_api_requests=mock.requests, blocked_external_urls=mock.blocked_external_urls,
                      page_errors=errors, dialogs=dialogs, mock_created_orders=mock.created_orders)
        context.close()
    print(json.dumps({'source': str(source), 'name': name, 'status': result['status'], 'error': result.get('error')}, ensure_ascii=False), flush=True)
    return result


def main():
    results = {
        'verification': 'Actual Chromium frontend; ALL API responses MOCKED',
        'limitations': 'No payment-provider, backend money movement, deployed service or Android/iOS runtime proof; native copies only tested as browser HTML.',
        'network': 'Mock localhost page/API routes fulfilled in Playwright; every external request aborted; no external network.',
        'timestamp_utc': datetime.now(timezone.utc).isoformat(),
        'sources': [{'path': str(s), 'sha256': hashlib.sha256(s.read_bytes()).hexdigest()} for s in SOURCES],
        'checks': [],
    }
    scenarios = [
        ('Cash default sends cash without wallet debit', cash_selection, {}),
        ('Wallet selection sends wallet and refreshes server balance', wallet_selection, {}),
        ('Insufficient wallet server error creates no fake order', insufficient_funds, {'balance': 2.00}),
        ('Duplicate submit while request pending sends one POST', duplicate_pending, {'delayed': True}),
        ('Network exception clears busy state and permits retry', network_failure_retry, {'abort_create': True}),
        ('Driver displays accrued earnings rather than wallet balance', driver_earnings, {}),
        ('Logout posts captured token and clears private order and wallet state', logout_state, {'private_order': True}),
        ('Server logout failure still clears private state and shows warning', logout_state, {'private_order': True, 'logout_failure': 'server'}),
        ('Network logout failure still clears private state and shows warning', logout_state, {'private_order': True, 'logout_failure': 'network'}),
        ('Late create response cannot restore private UI after logout', pending_create_logout, {'delayed': True}),
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
        'api_mocked': True, 'payment_provider_tested': False, 'native_runtime_tested': False,
    }
    RESULTS.write_text(json.dumps(results, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'results': str(RESULTS), 'summary': results['summary']}, ensure_ascii=False), flush=True)
    return 0 if results['summary']['success'] else 1


if __name__ == '__main__':
    sys.exit(main())
