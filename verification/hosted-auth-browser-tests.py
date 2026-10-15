"""Actual served KNTR HTML + actual isolated API/PostgreSQL authentication.

Only external fonts are blocked. No HTML or API response is substituted.
Credentials and tokens remain in process memory and a private transient config.
"""
import json
import os
import secrets
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
RESULT = ROOT / 'verification/hosted-auth-browser-results.json'


def main(config_path):
    config = json.loads(Path(config_path).read_text())
    base = config['base'].rstrip('/')
    assert urlparse(base).hostname in {'localhost', '127.0.0.1', '::1'}
    report = {'checked_at_utc': datetime.now(timezone.utc).isoformat(), 'scope': 'Real Chromium and real isolated server HTML/API/PostgreSQL; not a hosted Codespaces or native-device check.', 'apiMocked': False, 'htmlMocked': False, 'native': False, 'checks': [], 'page_errors': [], 'api_responses': []}
    browser = None

    def record(name):
        report['checks'].append({'name': name, 'passed': True})

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium'), headless=True, args=['--no-sandbox'])
            report['browser_version'] = browser.version

            def page_at(route):
                context = browser.new_context(viewport={'width': 430, 'height': 932}, service_workers='block')
                context.route('**/*', lambda request: request.continue_() if request.request.url.startswith(base + '/') else request.abort())
                page = context.new_page()
                page.set_default_timeout(10000)
                page.on('pageerror', lambda err: report['page_errors'].append(str(err)))
                page.on('response', lambda response: report['api_responses'].append({'path': urlparse(response.url).path, 'status': response.status, 'method': response.request.method}) if response.url.startswith(base + '/v1/') else None)
                response = page.goto(base + route, wait_until='load')
                assert response.status == 200
                assert page.locator('#apiBase').input_value() == '/v1'
                return page

            def identity(page):
                page.wait_for_function('() => (TOKEN && PROFILE && !authPending)')
                return page.evaluate('({id:PROFILE.id,role:PROFILE.role})')

            def assert_revoked(page, token):
                response = page.request.get(base + '/v1/auth/me', headers={'Authorization': 'Bearer ' + token})
                assert response.status == 401 and response.json()['error']['code'] == 'SESSION_EXPIRED'

            def logout(page):
                token = page.evaluate('TOKEN')
                page.get_by_role('button', name='خروج', exact=True).click()
                page.wait_for_function('() => (TOKEN === null && !logoutPending)')
                assert page.locator('#loginWrap').is_visible()
                assert_revoked(page, token)

            accounts = {}
            for role, route in [('customer', '/'), ('driver', '/app')]:
                page = page_at(route)
                assert page.locator('#email').input_value() == '' and page.locator('#password').input_value() == ''
                page.locator('#authModeBtn').click()
                assert page.locator('#registerFields').is_visible()
                assert page.locator('#registerRole option').all_text_contents() == ['عميل', 'سائق']
                password = 'Qat9!' + secrets.token_hex(9)
                email = 'kntr-auth-' + secrets.token_hex(6) + '@example.invalid'
                page.locator('#email').fill(email)
                page.locator('#password').fill(password)
                page.locator('#passwordConfirm').fill(password + 'x')
                page.locator('#fullName').fill('حساب اختبار ' + role)
                page.locator('#phone').fill('+999' + str(secrets.randbelow(10**9)).zfill(9))
                page.locator('#registerRole').select_option(role)
                before = len([r for r in report['api_responses'] if r['path'].endswith('/auth/register')])
                page.locator('#authSubmit').click()
                page.wait_for_function("() => (document.getElementById('loginErr').textContent.includes('غير متطابقتين'))")
                assert before == len([r for r in report['api_responses'] if r['path'].endswith('/auth/register')])
                record(role + ' password confirmation prevents a bad registration request')
                page.locator('#passwordConfirm').fill(password)
                with page.expect_response(lambda response: response.url == base + '/v1/auth/register' and response.request.method == 'POST') as response:
                    page.locator('#authSubmit').click()
                assert response.value.status == 201
                user = identity(page)
                assert user['role'] == role
                accounts[role] = {'email': email, 'password': password, 'id': user['id']}
                if role == 'customer':
                    page.wait_for_function("() => (document.getElementById('customerWalletBalance').textContent.includes('0.00'))")
                    assert page.locator('#customerView').is_visible()
                else:
                    page.wait_for_function("() => (document.getElementById('driverApproval').textContent.includes('بانتظار اعتماد'))")
                    assert page.locator('#btnAvail').is_disabled()
                    assert not [r for r in report['api_responses'] if r['path'] == '/v1/drivers/orders' and r['status'] == 403]
                record(role + ' registration reaches its real authenticated view')
                page.screenshot(path=str(RESULT.parent / ('hosted-auth-' + role + '.png')), full_page=True)
                logout(page)
                record(role + ' logout revokes the server session')
                page.locator('#email').fill(email)
                page.locator('#password').fill(password)
                page.locator('#authSubmit').click()
                assert identity(page)['id'] == user['id']
                record(role + ' can log in again with its registered password')
                logout(page)
                page.context.close()

            page = page_at('/app')
            page.locator('#email').fill(accounts['customer']['email'])
            page.locator('#password').fill('WrongQat9!' + secrets.token_hex(8))
            page.locator('#authSubmit').click()
            page.wait_for_function("() => (document.getElementById('loginErr').textContent.includes('غير صحيحة'))")
            assert page.locator('#loginWrap').is_visible() and page.evaluate('TOKEN') is None
            record('Incorrect password remains on the login page with a useful error')
            page.context.close()

            admin = page_at('/admin')
            admin.locator('#email').fill(config['admin']['email'])
            admin.locator('#password').fill(config['admin']['password'])
            admin.locator('#adminLoginBtn').click()
            admin.wait_for_function('() => (TOKEN && !loginPending)')
            assert admin.locator('#dash').is_visible()
            admin.wait_for_function("() => (document.getElementById('statsBox').querySelector('.stat') !== null)")
            token = admin.evaluate('TOKEN')
            record('Administrator logs in through the served dashboard and loads real statistics')
            admin.locator('#logoutBtn').click()
            admin.wait_for_function('() => (TOKEN === null && !logoutPending)')
            assert admin.locator('#loginBox').is_visible()
            assert_revoked(admin, token)
            record('Administrator logout revokes its server session')
            assert not report['page_errors'], report['page_errors']
            assert not [r for r in report['api_responses'] if r['status'] >= 500]
            browser.close()
            browser = None
        report['summary'] = {'success': True, 'passed': len(report['checks']), 'failed': 0}
    except Exception as error:
        report['error'] = str(error)
        report['summary'] = {'success': False, 'passed': len(report['checks']), 'failed': 1}
    finally:
        if browser:
            try:
                browser.close()
            except Exception:
                pass  # The Playwright context may already have closed on error.
        RESULT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'summary': report['summary'], 'report': str(RESULT)}), flush=True)
    return 0 if report['summary']['success'] else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
