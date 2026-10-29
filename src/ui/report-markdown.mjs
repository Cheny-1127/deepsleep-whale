const escapeHtml=text=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const escapedPunctuation=/[\\`*_\[\]<>#]/;

function inline(text,bold=true){
  let html='';
  for(let index=0;index<text.length;){
    if(text[index]==='\\'&&escapedPunctuation.test(text[index+1]||'')){html+=escapeHtml(text[index+1]);index+=2;continue;}
    if(bold&&text.startsWith('**',index)){
      let end=index+2;
      while(end<text.length){
        if(text[end]==='\\'&&escapedPunctuation.test(text[end+1]||'')){end+=2;continue;}
        if(text.startsWith('**',end))break;
        end++;
      }
      if(end<text.length){html+='<strong>'+inline(text.slice(index+2,end),false)+'</strong>';index=end+2;continue;}
    }
    html+=escapeHtml(text[index++]);
  }
  return html;
}

// 只解析日报生成器约定的标题、段落、加粗和缩进列表；其余输入按文本转义，不能直通 HTML。
export function reportMarkdownHtml(markdown){
  const output=[],lists=[];let paragraph=[];
  const flushParagraph=()=>{if(paragraph.length){output.push('<p>'+inline(paragraph.join(' '))+'</p>');paragraph=[];}};
  const closeLists=()=>{while(lists.length){output.push('</li></ul>');lists.pop();}};
  for(const line of String(markdown||'').split(/\r?\n/)){
    if(!line.trim()){flushParagraph();closeLists();continue;}
    const heading=line.match(/^(#{1,6})\s+(.+)$/),item=line.match(/^(\s*)[-*+]\s+(.*)$/);
    if(heading){flushParagraph();closeLists();const level=heading[1].length;output.push('<h'+level+'>'+inline(heading[2])+'</h'+level+'>');}
    else if(item){
      flushParagraph();const indent=item[1].replace(/\t/g,'  ').length;
      while(lists.length&&indent<lists.at(-1)){output.push('</li></ul>');lists.pop();}
      if(!lists.length||indent>lists.at(-1)){output.push('<ul><li>');lists.push(indent);}
      else output.push('</li><li>');
      output.push(inline(item[2]));
    }else{closeLists();paragraph.push(line.trim());}
  }
  flushParagraph();closeLists();return output.join('');
}
