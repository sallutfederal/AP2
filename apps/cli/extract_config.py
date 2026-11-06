import re
for f in ['recon_data/api_js.js','recon_data/app_login.js','recon_data/staging.js']:
    txt = open(f).read()
    print('====', f, len(txt))
    m = re.findall(r'"(?:domain|url|api|key|secret|token|password|endpoint)"\s*:\s*"[^"]+"', txt, re.I)
    vals = set()
    for x in m:
        v = x.split(':', 1)[1].strip().strip('"')
        vals.add(v)
    print('config strings:', len(vals))
    for x in sorted(vals)[:60]:
        print('   -', x[:120])