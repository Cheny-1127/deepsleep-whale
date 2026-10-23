'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {avatarUrl,avatarData,fetchAvatar} = require('../src/channels/subscription-avatar.cjs');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=';
const url = 'https://pbs.twimg.com/profile_images/123/avatar_normal.png';
test('avatar URLs and cache accept only bounded raster images from the fixed X host',()=>{
  assert.equal(avatarUrl(url),url);assert.equal(avatarData(png),png);
  for (const value of ['https://evil.test/profile_images/a.png','https://pbs.twimg.com.evil.test/profile_images/a.png','http://pbs.twimg.com/profile_images/a.png','https://pbs.twimg.com:444/profile_images/a.png','https://user@pbs.twimg.com/profile_images/a.png','https://pbs.twimg.com/media/a.png']) assert.equal(avatarUrl(value),'');
  for (const value of ['https://evil.test/a.png','data:image/svg+xml;base64,PHN2Zz4=','data:image/png;base64,PHN2Zz4=',png+'x'.repeat(140000)]) assert.equal(avatarData(value),'');
});
test('avatar requests reject redirects, oversized streams and wrong types; failures leave posts usable',async()=>{
  const requests = [],options = {fetchImpl:async(u,o)=>{requests.push({u,o});return new Response(Buffer.from(png.split(',')[1],'base64'),{headers:{'content-type':'image/png'}});}};
  assert.equal(await fetchAvatar(url,options),png);assert.equal(requests.length,1);assert.equal(requests[0].o.redirect,'error');
  assert.equal(await fetchAvatar('https://evil.test/a.png',options),'');assert.equal(requests.length,1);
  for (const response of [new Response('<svg/>',{headers:{'content-type':'image/svg+xml'}}),new Response('bad',{headers:{'content-type':'image/png','content-length':'100000'}}),new Response('x'.repeat(100000),{headers:{'content-type':'image/png'}}),new Response('bad',{status:404})]) assert.equal(await fetchAvatar(url,{fetchImpl:async()=>response}),'');
  assert.equal(await fetchAvatar(url,{fetchImpl:async()=>{throw Error('unavailable');}}),'');
});
