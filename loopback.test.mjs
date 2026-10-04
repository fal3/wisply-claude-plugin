// End-to-end test against a synthetic mock of Wisply on the fixed loopback
// port. It skips itself when the port is in use, so a running Wisply app is
// never contacted or disturbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {handle} from './bridge.mjs';
// Synthetic, well-formed token built at runtime; never a real Wisply token.
const TOKEN='wsp_'+'c3'.repeat(32);

test('synthetic loopback and stdio integration', async (t) => {
  const calls=[];
  const server=http.createServer(async (req,res)=>{
    let body='';
    for await (const chunk of req) body+=chunk;
    const message=JSON.parse(body);
    calls.push({path:req.url,authorization:req.headers.authorization,host:req.headers.host,message});
    if(message.params?.name==='get_action_items' && message.id==='redirect') {
      res.writeHead(302,{Location:'http://127.0.0.1:9/private'}).end();
      return;
    }
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{content:[{type:'text',text:'Synthetic memo only'}]}}));
  });
  try {
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(51771,'127.0.0.1',resolve);
    });
  } catch(error) {
    if(error.code==='EADDRINUSE') { t.skip('Fixed loopback port is occupied; preserve the running app.'); return; }
    throw error;
  }
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  // An unused proxy: the bridge must never send anything to it.
  const proxied=[];
  const proxy=http.createServer((req,res)=>{ proxied.push(req.url); res.writeHead(502).end(); });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>proxy.close(resolve)));

  await t.test('sends authorized read calls to fixed loopback only',async()=>{
    const result=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_memos'}},{token:TOKEN});
    assert.equal(result.result.content[0].text,'Synthetic memo only');
    assert.equal(calls[0].path,'/mcp');
    assert.equal(calls[0].host,'127.0.0.1:51771');
    assert.equal(calls[0].authorization,`Bearer ${TOKEN}`);
  });
  await t.test('answers the handshake and blocks setup and recording without an HTTP request',async()=>{
    const before=calls.length;
    for(const method of ['initialize','ping','tools/list']) {
      const result=await handle({jsonrpc:'2.0',id:2,method,params:{}},{token:TOKEN});
      assert.ok(result.result);
    }
    for(const name of ['setup_claude','start_recording','stop_recording','propose_follow_up']) {
      const result=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name}},{token:TOKEN});
      assert.equal(result.error.code,-32602);
    }
    assert.equal(calls.length,before);
  });
  await t.test('rejects HTTP redirects with a credential-safe error',async()=>{
    const result=await handle({jsonrpc:'2.0',id:'redirect',method:'tools/call',params:{name:'get_action_items'}},{token:TOKEN});
    assert.equal(result.result.isError,true);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes('/private'));
  });
  await t.test('stdio emits JSON-RPC frames only, preserves order and ignores proxies and the old variable',async()=>{
    const child=spawn(process.execPath,[new URL('./bridge.mjs',import.meta.url).pathname],{
      env:{
        PATH:process.env.PATH,
        WISPLY_PLUGIN_TOKEN:TOKEN,
        HTTP_PROXY:`http://127.0.0.1:${proxy.address().port}`,
        NODE_USE_ENV_PROXY:'1',
      },
      stdio:['pipe','pipe','pipe']
    });
    let output='',stderr='';
    child.stdout.on('data',x=>{output+=x;});
    child.stderr.on('data',x=>{stderr+=x;});
    child.stdin.end([
      '{invalid',
      JSON.stringify({jsonrpc:'2.0',id:'init',method:'initialize',params:{protocolVersion:'2025-06-18'}}),
      JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),
      JSON.stringify({jsonrpc:'2.0',id:'read',method:'tools/call',params:{name:'get_action_items'}}),
    ].join('\n')+'\n');
    const [code]=await once(child,'close');
    // The bridge itself writes nothing to stderr. Node 22 adds its own
    // experimental-feature warning when NODE_USE_ENV_PROXY is set.
    const bridgeErrors=stderr.split('\n').filter(line=>line && !/^\(node:\d+\) \[|^\(Use `node --trace-warnings/.test(line));
    assert.equal(code,0); assert.deepEqual(bridgeErrors,[]);
    assert.ok(!stderr.includes(TOKEN));
    const frames=output.trim().split('\n').map(x=>JSON.parse(x));
    assert.deepEqual(frames.map(frame=>frame.id),[null,'init','read']);
    assert.equal(frames[0].error.code,-32700);
    assert.equal(frames[2].result.content[0].text,'Synthetic memo only');
    assert.ok(!output.includes(TOKEN));
    assert.deepEqual(proxied,[]);
  });
  await t.test('a token exported as WISPLY_MCP_TOKEN is never picked up',async()=>{
    const before=calls.length;
    const child=spawn(process.execPath,[new URL('./bridge.mjs',import.meta.url).pathname],{
      env:{PATH:process.env.PATH, WISPLY_MCP_TOKEN:TOKEN}, stdio:['pipe','pipe','pipe']
    });
    let output='';
    child.stdout.on('data',x=>{output+=x;});
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:'old',method:'tools/call',params:{name:'list_memos'}})+'\n');
    await once(child,'close');
    const frame=JSON.parse(output.trim());
    assert.equal(frame.result.isError,true);
    assert.match(frame.result.content[0].text,/Wisply MCP token is not set/);
    assert.equal(calls.length,before);
  });
});
