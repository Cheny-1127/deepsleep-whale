'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {dailyContent}=require('../src/reports/model.cjs');
const render=async content=>(await import('../src/ui/report-markdown.mjs')).reportMarkdownHtml(content);
const entry=(id,title,status='done',details='')=>({id,sourceKey:id,date:'2026-10-28',title,details,source:'manual',status,included:true,sourceActive:true});

test('daily Markdown renders business headings, bold work titles and nested result lists',async()=>{
  const content=dailyContent([entry('done','完成支付校验','done','验证正常支付\n补齐超时处理'),entry('risk','等待接口确认','blocked'),entry('plan','回归退款流程','planned')],'2026-10-28');
  const html=await render(content);
  assert.match(html,/<h1>工作日报 · 2026-10-28<\/h1><p>今日工作 1 项<\/p>/);
  assert.match(html,/<h2>今日工作<\/h2><ul><li><strong>完成支付校验<\/strong>（已完成）<ul><li>验证正常支付<\/li><li>补齐超时处理<\/li><\/ul><\/li><\/ul>/);
  assert.match(html,/<h2>问题与风险<\/h2>/);assert.match(html,/<h2>工作计划<\/h2>/);
});

test('escaped user punctuation stays literal and source HTML cannot create active elements',async()=>{
  const title='保留 *星号*、[括号]、_下划线_、`代码` 与 \\ 路径';
  const content=dailyContent([entry('literal',title,'done','<img src=x onerror=alert(1)>\n<script>alert(1)</script> & "引号"')],'2026-10-28');
  const html=await render(content);
  assert.ok(html.includes('<strong>'+title+'</strong>'));
  assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html,/&amp; &quot;引号&quot;/);assert.doesNotMatch(html,/<(?:img|script|a|iframe)\b/);
  assert.equal(await render('<svg onload=alert(1)>'),'<p>&lt;svg onload=alert(1)&gt;</p>');
});

test('empty reports and adjacent sibling works retain their readable structure',async()=>{
  assert.equal(await render(dailyContent([],'2026-10-28')),'<h1>工作日报 · 2026-10-28</h1><p>今日工作 0 项</p><p>暂无工作记录。</p>');
  assert.equal(await render('- **第一项**\n  - 结果\n- **第二项**\n\n结束说明'),'<ul><li><strong>第一项</strong><ul><li>结果</li></ul></li><li><strong>第二项</strong></li></ul><p>结束说明</p>');
});
