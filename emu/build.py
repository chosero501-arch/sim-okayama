import base64,sys
t=open('site/template.html',encoding='utf8').read()
js=open('gb.js',encoding='utf8').read()
rom=base64.b64encode(open('rom.gbc','rb').read()).decode()
out=t.replace('/*GBJS*/',js.replace('</script','<\\/script')).replace('/*ROM*/',rom)
open('site/index.html','w',encoding='utf8').write(out)
print(len(out))
