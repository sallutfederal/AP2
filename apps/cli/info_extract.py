import re
csp = "default-src 'self'; connect-src 'self' *.bugsnag.com api.amplifique.me *.freshworks.com *.freshdesk.com cdn.amplifique.me *.google-analytics.com *.google.com; font-src 'self' fonts.gstatic.com cdn.amplifique.me; frame-src 'self' *.youtube.com *.google.com *.recaptcha.net *.swapcards.com.br google.com; img-src 'self' *.ytimg.com s3-sa-east-1.amazonaws.com *.youtube.com validator.swagger.io placehold.it cdn.amplifique.me s3.amazonaws.com data:; script-src 'self' 'unsafe-inline' *.recaptcha.net *.gstatic.com cdn.amplifique.me ajax.googleapis.com *.newrelic.com *.freshworks.com *.google.com *.swapcards.com.br *.googletagmanager.com *.google-analytics.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com *.freshworks.com cdn.amplifique.me"
doms = set(re.findall(r"(?:'|https?://)([a-zA-Z0-9\-.]+\.[a-zA-Z]{2,})", csp))
print("DOMINIOS PERMITIDOS PELA CSP:")
for d in sorted(doms):
    print("  -", d)
print()
print("TECNOLOGIAS / IDS EXPOSTOS:")
print("  - Bugsnag API Key: 5094816004b0c138b49f2dbf95975d8f")
print("  - Freshworks Widget ID: 73000004075")
print("  - reCAPTCHA Site Key: 6LfZORUdAAAAAGeyjDsPWXIBZL-o-frY9a3ZKuXM")
print("  - Bugsnag App Version: production-d3995bc (prod) / staging-e6 (staging)")
print("  - Domains internos: app.sankhyadespesas.com.br (prod), staging.sankhyadespesas.com.br (staging)")
