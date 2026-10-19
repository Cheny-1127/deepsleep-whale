'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),tls=require('node:tls');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {ImapFlow}=require('imapflow');
const {createImapMail}=require('../src/channels/imap-mail.cjs');

// 本地 TLS 服务模拟协议响应，验证真实客户端的只读命令与完整正文解析。
test('real IMAP client uses TLS, EXAMINE and UID BODY.PEEK without writing flags', {timeout:15000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-imap-wire-')),keyFile=path.join(dir,'key.pem'),certFile=path.join(dir,'cert.pem');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost','-keyout',keyFile,'-out',certFile],{stdio:'ignore'});
  const cert=fs.readFileSync(certFile),key=fs.readFileSync(keyFile),commands=[],sockets=new Set();
  const body='Hello from IMAP fixture\n'+'长正文与 SQL 内容保留完整\n'.repeat(1000)+'完整正文结束\n';
  const source=Buffer.from('From: Sender <sender@example.com>\r\nTo: owner@example.com\r\nSubject: protocol fixture\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+body.replace(/\n/g,'\r\n'));
  const server=tls.createServer({key,cert},socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
    socket.write('* OK local test server\r\n');let buffered='';
    socket.on('data',data=>{
      buffered+=data.toString();
      while(buffered.includes('\r\n')) {
        const end=buffered.indexOf('\r\n'),line=buffered.slice(0,end);buffered=buffered.slice(end+2);
        const match=/^(\S+) (.*)$/.exec(line);if(!match)continue;
        const [,tag,command]=match;commands.push(command.replace(/LOGIN .*/i,'LOGIN [redacted]'));
        const ok=()=>socket.write(`${tag} OK done\r\n`);
        if(command==='CAPABILITY'){socket.write('* CAPABILITY IMAP4rev1\r\n');ok();}
        else if(command.startsWith('LOGIN '))ok();
        else if(command.startsWith('LIST ')){socket.write('* LIST (\\Noselect) "/" ""\r\n');ok();}
        else if(command.startsWith('EXAMINE ')) {
          socket.write('* FLAGS (\\Seen)\r\n* 1 EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 10] valid\r\n* OK [UIDNEXT 2] next\r\n');
          socket.write(`${tag} OK [READ-ONLY] selected\r\n`);
        }else if(/^(?:UID )?FETCH /.test(command)) {
          const values=['UID 1'];
          if(command.includes('ENVELOPE'))values.push('ENVELOPE ("Mon, 19 Oct 2026 10:00:00 +0800" "protocol fixture" (("Sender" NIL "sender" "example.com")) NIL NIL ((NIL NIL "owner" "example.com")) NIL NIL NIL "<fixture@example.com>")');
          if(command.includes('RFC822.SIZE'))values.push('RFC822.SIZE '+source.length);
          if(command.includes('BODY.PEEK[]')) {
            socket.write('* 1 FETCH ('+values.join(' ')+' BODY[] {'+source.length+'}\r\n');socket.write(source);socket.write(')\r\n');
          }else socket.write('* 1 FETCH ('+values.join(' ')+')\r\n');
          ok();
        }else if(command==='LOGOUT'){socket.write('* BYE\r\n');ok();socket.end();}
        else socket.write(`${tag} BAD unsupported fixture command\r\n`);
      }
    });
  });
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  class TrustedLocalClient extends ImapFlow {
    constructor(options){super({...options,tls:{...options.tls,ca:cert}});}
  }
  const imap=createImapMail({Client:TrustedLocalClient}),config={email:'owner@example.com',password:'local-fixture-only',host:'localhost',port:server.address().port};
  await assert.rejects(createImapMail().list(config),/证书验证失败/);
  const list=await imap.list(config);assert.equal(list.messages[0].subject,'protocol fixture');assert.equal(list.messages[0].id,'10:1');
  assert.equal((await imap.read(config,'10:1')).body,body,'the complete long MIME body, including its ending, must survive TLS fetch and parsing');
  assert.equal((await imap.readMany(config,['10:1']))[0].body,body,'background cache downloads must use the same complete read-only MIME fetch');
  assert.ok(commands.filter(cmd=>cmd.startsWith('EXAMINE ')).length===3);
  assert.ok(commands.some(cmd=>cmd.startsWith('UID FETCH ')&&cmd.includes('BODY.PEEK[]')));
  assert.ok(!commands.some(cmd=>/^(?:UID )?(?:STORE|APPEND|EXPUNGE|CLOSE|SELECT|MOVE|COPY)\b/.test(cmd)));
});
