'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readReportEnvironment}=require('../src/reports/environment.cjs');
test('report environment reads local config with process precedence without exporting secrets',t=>{
  const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'report-env-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(rootDir,'.env'),'WHALE_REPORT_OBSIDIAN_DIR="/workspace/note/Dd work report"\nWHALE_REPORT_JENKINS_TOKEN=local-secret\nWHALE_REPORT_JENKINS_USERNAME=local-user\n');
  const env={WHALE_REPORT_JENKINS_TOKEN:'process-secret'},before=JSON.stringify(process.env);
  const result=readReportEnvironment({rootDir,env});
  assert.equal(result.archiveDir,'/workspace/note/Dd work report');assert.equal(result.jenkinsToken,'process-secret');assert.equal(result.jenkinsUser,'local-user');
  assert.deepEqual(env,{WHALE_REPORT_JENKINS_TOKEN:'process-secret'});assert.ok(JSON.stringify(process.env)===before,'process environment unchanged');
});
