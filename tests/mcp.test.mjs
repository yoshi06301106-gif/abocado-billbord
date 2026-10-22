import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { openStore } from '../lib/store.mjs';
import { openAccess } from '../lib/access.mjs';
import { createGateway, invokeTool } from '../lib/gateway.mjs';

test('OAuth PKCE + MCP: scoped direct posting, replay safety, receipts, revocation, no Ken permissions', async () => {
  const store = openStore(':memory:'), access = openAccess(':memory:');
  const issuer='https://board.example'; const gateway=createGateway({store,access,publicUrl:issuer});
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${gateway.address().port}`;
  const action=(action,args)=>store.dispatch({action,revision:store.read().revision,...args});
  const topicId=action('createTopic',{title:'接続テスト',brief:'テスト資料'}).result;
  const privateId=action('createTopic',{title:'非共有の議題',brief:'秘密'}).result;
  try {
    assert.equal((await fetch(base+'/api/session')).status,404);
    let r=await fetch(base+'/mcp'); assert.equal(r.status,401); assert.match(r.headers.get('www-authenticate'),/oauth-protected-resource/);
    const metadata=await (await fetch(base+'/.well-known/oauth-authorization-server')).json(); assert.deepEqual(metadata.code_challenge_methods_supported,['S256']);
    const send=(path,data,headers={})=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
    r=await send('/register',{client_name:'Test Gemini',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none'}); assert.equal(r.status,201); const client=await r.json();
    assert.equal((await send('/register',{redirect_uris:['http://attacker.example/callback']})).status,400);
    const verifier=randomBytes(32).toString('base64url'), challenge=createHash('sha256').update(verifier).digest('base64url');
    const params=new URLSearchParams({client_id:client.client_id,response_type:'code',redirect_uri:client.redirect_uris[0],resource:issuer+'/mcp',code_challenge:challenge,code_challenge_method:'S256',state:'original'});
    r=await fetch(base+'/authorize?'+params,{redirect:'manual'}); assert.equal(r.status,302); const wait=r.headers.get('location');
    const pending=access.list().pending[0]; assert.equal(pending.clientName,'Test Gemini');
    const grant=access.approve(pending.id,'Ludy',[topicId],store.read().topics.map(t=>t.id));
    r=await fetch(base+wait,{redirect:'manual'}); assert.equal(r.status,302); const callback=new URL(r.headers.get('location')); assert.equal(callback.searchParams.get('state'),'original');
    const tokenInput={client_id:client.client_id,grant_type:'authorization_code',code:callback.searchParams.get('code'),redirect_uri:client.redirect_uris[0],resource:issuer+'/mcp',code_verifier:verifier};
    const tokenCall=input=>fetch(base+'/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(input)});
    assert.equal((await tokenCall({...tokenInput,code_verifier:'x'.repeat(43)})).status,400);
    r=await tokenCall(tokenInput); assert.equal(r.status,200); const token=await r.json(); assert.ok(token.access_token);
    assert.equal((await tokenCall(tokenInput)).status,400);
    const rpc=async(method,params)=>{const r=await send('/mcp',{jsonrpc:'2.0',id:1,method,params},{Authorization:`Bearer ${token.access_token}`}); return {status:r.status,data:await r.json()};};
    assert.equal((await rpc('initialize',{protocolVersion:'2025-06-18'})).data.result.serverInfo.name,'abocado-board');
    const notification = await send('/mcp',{jsonrpc:'2.0',method:'notifications/initialized'},{Authorization:`Bearer ${token.access_token}`}); assert.equal(notification.status,202);
    const tools=(await rpc('tools/list')).data.result.tools; assert.equal(tools.length,4); assert.ok(!tools.some(t=>t.name==='decide'));
    const call=async(name,args={})=>(await rpc('tools/call',{name,arguments:args})).data.result;
    const list=JSON.parse((await call('list_topics')).content[0].text); assert.equal(list.topics.length,1); assert.equal(list.author,'Ludy');
    assert.equal((await call('get_topic',{topic_id:privateId})).isError,true);
    assert.equal((await call('decide',{})).isError,true);
    const input={topic_id:topicId,round:1,revision:store.read().revision,request_id:'test_post_001',content:'Ludyの保存テスト',references:[]};
    const post=JSON.parse((await call('post_proposal',input)).content[0].text); assert.equal(post.author,'Ludy'); assert.equal(post.source,'mcp');
    const replay=JSON.parse((await call('post_proposal',input)).content[0].text); assert.equal(replay.id,post.id); assert.equal(store.read().posts.length,1);
    assert.equal((await call('post_proposal',{...input,content:'再送で改ざん'})).isError,true);
    assert.equal((await call('post_proposal',{...input,author:'Ken'})).isError,true);
    assert.deepEqual(JSON.parse((await call('get_receipt',{post_id:post.id})).content[0].text),post);
    access.revoke(grant.id); assert.equal((await rpc('tools/list')).status,401);
    assert.equal(store.read().posts.length,1);
  } finally { await new Promise(resolve=>gateway.close(resolve)); access.close(); store.close(); }
});

test('authorization expiry, resource isolation, grant validation, and independent round privacy', () => {
  let time=1000; const a=openAccess(':memory:',{clock:()=>time}), s=openStore(':memory:');
  const run=(action,args)=>s.dispatch({action,revision:s.read().revision,...args});
  try {
    const t=run('createTopic',{title:'独立案',brief:'背景'}).result;
    run('post',{topicId:t,round:1,author:'Love',content:'先に見せない',references:[]});
    const grant = { id:'test-client',author:'Ludy',topics:[t],scope:'board:read' };
    assert.equal(invokeTool('get_topic',{topic_id:t},s,grant).posts.length,0);
    assert.throws(()=>invokeTool('post_proposal',{topic_id:t,round:1,revision:s.read().revision,request_id:'test_readonly',content:'不可'},s,grant),/投稿権限/);
    const client=a.register({redirect_uris:['https://client.example/cb']}); const v=randomBytes(32).toString('base64url');
    const args={client_id:client.client_id,redirect_uri:'https://client.example/cb',response_type:'code',resource:'https://b.example/mcp',code_challenge_method:'S256',code_challenge:createHash('sha256').update(v).digest('base64url')};
    assert.throws(()=>a.start({...args,redirect_uri:'https://other.example'},'https://b.example'),/戻り先/);
    assert.throws(()=>a.start({...args,resource:'https://other.example/mcp'},'https://b.example'),/resource/);
    let pending=a.start(args,'https://b.example'); assert.throws(()=>a.approve(pending,'Ken',[t],[t]),/投稿者/);
    time+=600001; assert.throws(()=>a.approve(pending,'Ludy',[t],[t]),/期限切れ/);
  } finally { a.close(); s.close(); }
});
