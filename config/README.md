# config/ 私有配置目录

本目录存放**私有配置文件**，已被 `.gitignore` 排除，不会进入公开仓库（提交前钩子也会拦截它们）：

| 文件 | 说明 |
|---|---|
| `key.txt`（可选） | 平台级 DeepSeek 密钥，内容为一行 `sk-...`。服务端密钥读取优先级：环境变量 `DEEPSEEK_API_KEY` → 环境变量 `DINGAO_KEY_FILE` 指定的文件 → `config/key.txt` |
| `secret.key`（自动生成） | AES-256-GCM 加密密钥，用于加密存储用户自配的 DeepSeek Key。首次启动时自动创建；**切勿提交或分享**，丢失后已存密文无法解密（用户需重新配置 Key） |
