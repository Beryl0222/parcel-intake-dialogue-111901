# 园区选址咨询中的复合业态与待核事实

utterances 按数组顺序记录咨询发言。places 的 uses 以楼层为键，aliases 保存现场口称。rules 的 id 是清单引用号，text 是清单原文。

资料保存在 `data/inputs.json`，采用 UTF-8 JSON。记录、人员、地点和业务编号均为合成内容。

运行环境为 Node.js 22.23.4，资料工具和测试使用 Node.js 标准库。

```sh
npm run inspect:data
npm test
```

`inspect:data` 读取资料并列出记录数。测试核对该批资料的字段和引用完整性。
