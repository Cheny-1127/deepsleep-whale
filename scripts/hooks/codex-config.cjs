'use strict';
// 命令行预览入口；配置生成逻辑由 src/hooks 统一维护。
const { createCodexConfig:createConfig } = require('../../src/hooks/config.cjs');
if (require.main === module) process.stdout.write(JSON.stringify(createConfig(), null, 2) + '\n');
module.exports = { createConfig };
