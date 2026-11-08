import {reportMarkdownHtml} from './report-markdown.mjs';
const escape=text=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

// 沿用报告的安全文本解析；补充聊天常见的代码块和有序列表，不执行 HTML 或生成外链。
export function aiMarkdownHtml(text){
  const output=[];let plain=[],code=null,ordered=[];
  const flushPlain=()=>{if(plain.length){output.push(reportMarkdownHtml(plain.join('\n')));plain=[];}};
  const flushOrdered=()=>{if(ordered.length){output.push('<ol>'+ordered.map(line=>'<li>'+reportMarkdownHtml(line)+'</li>').join('')+'</ol>');ordered=[];}};
  const flushCode=()=>{output.push('<pre><code>'+escape(code.join('\n'))+'</code></pre>');code=null;};
  for(const line of String(text||'').split(/\r?\n/)){
    if(/^\s*```/.test(line)){flushPlain();flushOrdered();if(code===null)code=[];else flushCode();continue;}
    if(code!==null){code.push(line);continue;}
    const item=line.match(/^\s*\d+[.)、]\s+(.*)$/);
    if(item){flushPlain();ordered.push(item[1]);}else{flushOrdered();plain.push(line);}
  }
  flushPlain();flushOrdered();if(code!==null)flushCode();return output.join('');
}
