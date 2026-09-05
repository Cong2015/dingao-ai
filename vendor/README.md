# vendor/ 浏览器端第三方库

- `docx.iife.js`（约 1.1MB）：[docx](https://www.npmjs.com/package/docx) v9.x 的浏览器端构建（IIFE 格式，暴露为 `window.docx`）。
  用途：**Word 导出在浏览器本地完成**——论文全文在用户自己的浏览器里生成 .docx，不经过服务器，这是「本地优先」架构隐私承诺的一部分（论文内容零上传）。

  本项目前端无构建步骤（原生 JS），故以 IIFE 形式引入该库。若需重新构建，可参考 docx 官方文档的 browser 打包方式。
