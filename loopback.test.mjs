// End-to-end test against a synthetic mock of Wisply on the fixed loopback
// port. It skips itself when the port is in use, so a running Wisply app is
// never contacted or disturbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {handle} from './bridge.mjs';
import {expectedProof} from './lib/identity.mjs';
import {NOT_WISPLY_MESSAGE} from './lib/shared.mjs';
// Synthetic, well-formed tokens built at runtime; never real Wisply tokens.
const TOKEN='wsp_'+'c3'.repeat(32);
const CONNECTOR='wspc_'+'d4'.repeat(32);
const OTHER='wsp_'+'e5'.repeat(32);

test('synthetic loopback and stdio integration', async (t) => {
  const calls=[];
  const challenges=[];
  // What the mock proves on /mcp/identity: 'valid' holds the synthetic
  // tokens; 'wrong' holds a different full-access token.
  let identityMode='valid';
  const server=http.createServer(async (req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/mcp/identity') {
      const nonce=url.searchParams.get('nonce');
      challenges.push({method:req.method,nonce,authorization:req.headers.authorization,host:req.headers.host});
      const full=identityMode==='valid' ? TOKEN : OTHER;
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({
        server:'wisply', scheme:'wisply-mcp-identity-v1', algorithm:'HMAC-SHA256', port:51771, nonce,
        proofs:{full:expectedProof(full,51771,nonce).toString('hex'), connector:expectedProof(CONNECTOR,51771,nonce).toString('hex')},
      }));
      return;
    }
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

  await t.test('sends authorized read calls to fixed loopback only, after a token-free identity check',async()=>{
    const result=await handle({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'list_memos'}},{token:TOKEN});
    assert.equal(result.result.content[0].text,'Synthetic memo only');
    assert.equal(calls.length,1);
    assert.equal(calls[0].path,'/mcp');
    assert.equal(calls[0].host,'127.0.0.1:51771');
    assert.equal(calls[0].authorization,`Bearer ${TOKEN}`);
    assert.equal(challenges.length,1);
    assert.equal(challenges[0].method,'GET');
    assert.equal(challenges[0].host,'127.0.0.1:51771');
    assert.equal(challenges[0].authorization,undefined);
    assert.match(challenges[0].nonce,/^[0-9a-f]{32}$/);
  });
  await t.test('a connector token is checked against the connector proof and then sent',async()=>{
    const before=calls.length;
    const result=await handle({jsonrpc:'2.0',id:'connector',method:'tools/call',params:{name:'get_live_transcript'}},{token:CONNECTOR});
    assert.equal(result.result.content[0].text,'Synthetic memo only');
    assert.equal(calls.length,before+1);
    assert.equal(calls.at(-1).authorization,`Bearer ${CONNECTOR}`);
  });
  await t.test('a listener with the wrong proof never receives the token',async()=>{
    const before=calls.length;
    const challengesBefore=challenges.length;
    identityMode='wrong';
    try {
      const result=await handle({jsonrpc:'2.0',id:'impostor',method:'tools/call',params:{name:'list_memos'}},{token:TOKEN});
      assert.equal(result.result.isError,true);
      assert.equal(result.result.content[0].text,NOT_WISPLY_MESSAGE);
      assert.ok(!JSON.stringify(result).includes(TOKEN));
    } finally {
      identityMode='valid';
    }
    assert.equal(challenges.length,challengesBefore+1);
    assert.equal(calls.length,before);
  });
  await t.test('answers the handshake and blocks setup and recording without an HTTP request',async()=>{
    const before=calls.length;
    const challengesBefore=challenges.length;
    for(const method of ['initialize','ping','tools/list']) {
      const result=await handle({jsonrpc:'2.0',id:2,method,params:{}},{token:TOKEN});
      assert.ok(result.result);
    }
    for(const name of ['setup_claude','start_recording','stop_recording','propose_follow_up']) {
      const result=await handle({jsonrpc:'2.0',id:2,method:'tools/call',params:{name}},{token:TOKEN});
      assert.equal(result.error.code,-32602);
    }
    assert.equal(calls.length,before);
    assert.equal(challenges.length,challengesBefore);
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
    const challengesBefore=challenges.length;
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
    assert.equal(challenges.length,challengesBefore);
  });
  await t.test('every challenge used a fresh nonce and carried no token',async()=>{
    const nonces=challenges.map(challenge=>challenge.nonce);
    assert.equal(new Set(nonces).size,nonces.length);
    assert.ok(challenges.every(challenge=>challenge.authorization===undefined));
  });
});
