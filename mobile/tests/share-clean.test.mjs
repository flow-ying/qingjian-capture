import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanShareText,clipboardSuggestion,cleanUrl,cleanTitle} from '../app/src/main/assets/web/share-clean.js';

const cases=[
 ['B站短链',`【这可能是最好的Rust入门教程-哔哩哔哩】 https://b23.tv/AbC12xY`,'',{body:'这可能是最好的Rust入门教程',source:'https://b23.tv/AbC12xY'}],
 ['B站嵌套括号+追踪参数',`【【硬核】Obsidian 工作流分享-哔哩哔哩】 https://www.bilibili.com/video/BV1xx411c7mD/?share_source=copy_web&vd_source=abc123&p=2`,'',{body:'【硬核】Obsidian 工作流分享',source:'https://www.bilibili.com/video/BV1xx411c7mD/?p=2'}],
 ['小红书新版',`【周末去哪儿｜东京小众咖啡店合集 - 小鹿 | 小红书 - 你的生活指南】 😆 Kq3mZ8xLp2 😆 https://www.xiaohongshu.com/discovery/item/66aa11bb?xsec_token=ABx&xsec_source=app_share`,'',{body:'周末去哪儿｜东京小众咖啡店合集',source:'https://www.xiaohongshu.com/discovery/item/66aa11bb?xsec_token=ABx&xsec_source=app_share'}],
 ['小红书旧版口令',`小鹿发布了一篇小红书笔记，快来看吧！ 😆 Kq3mZ8xLp2 😆 http://xhslink.com/a/AbCd, 复制本条信息，打开【小红书】App查看精彩内容！`,'',{body:'',source:'http://xhslink.com/a/AbCd'}],
 ['知乎回答',`如何评价 Obsidian 1.9 的新功能？ - 张三的回答 - 知乎 https://www.zhihu.com/question/123/answer/456?utm_psn=789&utm_source=wechat_session`,'',{body:'如何评价 Obsidian 1.9 的新功能？',source:'https://www.zhihu.com/question/123/answer/456'}],
 ['抖音口令',`7.43 复制打开抖音，看看【小王的作品】三分钟学会做番茄炒蛋 # 美食 # 家常菜 https://v.douyin.com/iRNBhq4A/ M@w.Fu 12/01 aNY:/ `,'',{body:'三分钟学会做番茄炒蛋 # 美食 # 家常菜',source:'https://v.douyin.com/iRNBhq4A/'}],
 ['微信文章仅链接+subject','https://mp.weixin.qq.com/s/AbCdEf','一文读懂 LiveSync 同步原理',{body:'一文读懂 LiveSync 同步原理',source:'https://mp.weixin.qq.com/s/AbCdEf'}],
 ['浏览器分享','Obsidian Help https://help.obsidian.md/','',{body:'Obsidian Help',source:'https://help.obsidian.md/'}],
 ['GitHub 标题后缀','GitHub - obsidianmd/obsidian-releases: Community plugins list https://github.com/obsidianmd/obsidian-releases','',{body:'GitHub - obsidianmd/obsidian-releases: Community plugins list',source:'https://github.com/obsidianmd/obsidian-releases'}]
];
for(const [name,input,subject,want]of cases)test('分享清洗：'+name,()=>{
 const r=cleanShareText(input,subject);
 assert.equal(r.type,'link');assert.equal(r.source,want.source);assert.equal(r.body,want.body);
});

test('纯文本不预选链接也不改写',()=>{
 const r=cleanShareText('明天下午三点开会\n记得带 U 盘');
 assert.equal(r.type,null);assert.equal(r.body,'明天下午三点开会\n记得带 U 盘');assert.equal(r.source,'');
});
test('多链接保留用户原文（链接内联），首个为来源',()=>{
 const r=cleanShareText('参考 https://a.com/x 和 https://b.com/y?utm_source=x');
 assert.equal(r.source,'https://a.com/x');assert.equal(r.body,'参考 https://a.com/x 和 https://b.com/y?utm_source=x');
});
test('URL 只剥离追踪参数、保留平台必需参数与尾部标点处理',()=>{
 assert.equal(cleanUrl('https://x.com/a?utm_source=1&id=2).'),'https://x.com/a?id=2');
 assert.equal(cleanUrl('https://b23.tv/x?share_source=copy'),'https://b23.tv/x');
});
test('标题签名逐层剥离',()=>{
 assert.equal(cleanTitle('标题 - 某人的文章 - 知乎'),'标题');
 assert.equal(cleanTitle('只是普通标题'),'只是普通标题');
});
test('剪贴板轻提示：链接 / 分享 / 文本 / 已填入不提示',()=>{
 assert.deepEqual(clipboardSuggestion('https://a.com/x '),{kind:'link',label:'填入刚复制的链接',text:'https://a.com/x'});
 assert.equal(clipboardSuggestion('看这个 https://a.com/x').kind,'share');
 assert.equal(clipboardSuggestion('一段文字').kind,'text');
 assert.equal(clipboardSuggestion('一段文字',{body:'我写了一段文字'}),null);
 assert.equal(clipboardSuggestion('   '),null);
});
