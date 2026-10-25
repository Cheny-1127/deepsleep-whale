'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createCipheriv}=require('node:crypto');
const {createWechatApi,incoming}=require('../src/channels/wechat-api.cjs');
const {avatarFromImage,userProfile}=require('../src/channels/wechat-profile.cjs');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXkAAAAASUVORK5CYII=','base64');
test('image downloads decrypt the three Tencent key encodings without sending bot credentials',async()=>{
  const key=Buffer.from('00112233445566778899aabbccddeeff','hex'),cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(png),cipher.final()]);
  const forms=[{aeskey:key.toString('hex'),media:{encrypt_query_param:'a+b&c',encrypt_type:1}},{media:{aes_key:key.toString('base64'),encrypt_query_param:'x'}},{media:{aes_key:Buffer.from(key.toString('hex')).toString('base64'),full_url:'https://novac2c.cdn.weixin.qq.com/c2c/download?x=y'}}];
  for(const item of forms){let request;const api=createWechatApi({fetchImpl:async(url,options)=>{request={url,options};return new Response(encrypted);}});assert.deepEqual(await api.image(item),png);assert.equal(request.options.headers,undefined);assert.equal(request.options.redirect,'error');assert.equal(new URL(request.url).origin,'https://novac2c.cdn.weixin.qq.com');}
});
test('untrusted image URLs and malformed keys fail before any request',async()=>{
  let requests=0;const api=createWechatApi({fetchImpl:async()=>{requests++;throw Error('unexpected');}});
  for(const full_url of ['http://novac2c.cdn.weixin.qq.com/c2c/download','https://example.com/c2c/download','https://novac2c.cdn.weixin.qq.com.evil.test/c2c/download','https://user@novac2c.cdn.weixin.qq.com/c2c/download','https://novac2c.cdn.weixin.qq.com/other'])await assert.rejects(api.image({media:{full_url}}));
  await assert.rejects(api.image({aeskey:'invalid',media:{encrypt_query_param:'x'}}));await assert.rejects(api.image({media:{aes_key:'bad',encrypt_query_param:'x'}}));assert.equal(requests,0);
});
test('image streams enforce actual size, declared size, cancellation and invalid ciphertext',async()=>{
  const item={media:{encrypt_query_param:'x'}};
  for(const response of [new Response(png,{headers:{'content-length':String(5*1024*1024)}}),new Response(Buffer.alloc(4*1024*1024+17))]){const api=createWechatApi({fetchImpl:async()=>response});await assert.rejects(api.image(item),/4 MB/);}
  const api=createWechatApi({fetchImpl:async()=>new Response('not ciphertext')});await assert.rejects(api.image({aeskey:'00112233445566778899aabbccddeeff',media:{encrypt_query_param:'x'}}));
  const controller=new AbortController();controller.abort();await assert.rejects(api.image(item,controller.signal));
});
test('incoming images retain metadata without becoming text and dangerous avatar data fails before native decoding',()=>{
  const item={media:{encrypt_query_param:'x'}},message=incoming({message_id:'photo',message_type:1,from_user_id:'owner',to_user_id:'bot',item_list:[{type:2,image_item:item}]},'bot');
  assert.equal(message.text,'');assert.deepEqual(message.images,[item]);
  const decoder={createFromBuffer:()=>assert.fail('must reject before decoding')};
  assert.throws(()=>avatarFromImage(Buffer.from('<svg/>'),decoder),/PNG/);
  const oversized=Buffer.from(png);oversized.writeUInt32BE(9000,16);assert.throws(()=>avatarFromImage(oversized,decoder),/尺寸/);
  assert.throws(()=>avatarFromImage(Buffer.alloc(4*1024*1024+1),decoder),/4 MB/);
  assert.throws(()=>userProfile({avatar:'https://example.com/pic'}),/头像格式/);assert.throws(()=>userProfile({nickname:'a\nb'}),/单行/);
});
