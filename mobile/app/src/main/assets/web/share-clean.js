// Smart cleaning for “系统分享 → 清笺” text (微信 / B站 / 小红书 / 知乎 / 抖音 / 浏览器 …).
// Pure functions, unit-tested in tests/share-clean.test.mjs. Conservative by design:
// only well-known boilerplate is removed; anything unrecognised stays in the body.
const URL_RE=/https?:\/\/[^\s<>"'，。！？、；：（）【】「」『』《》]+/gi;
const TRAIL=/[.,;:!?)\]}'"’”…~]+$/;
// Query keys that are pure share/tracking noise. Platform tokens such as 小红书 xsec_token are kept on purpose.
const TRACKING=/^(utm_[a-z]+|spm_id_from|vd_source|share_source|share_medium|share_plat|share_session_id|share_tag|share_from|unique_k|from_spmid|bbid|ts|is_story_h5|plat_id|buvid|up_id|timestamp|from_source|isappinstalled|clicktime|enterid|sharer_shareinfo|sharer_shareinfo_first)$/i;
const SITES='哔哩哔哩|bilibili|知乎|小红书|微博|豆瓣|抖音|今日头条|简书|CSDN博客|CSDN|掘金|少数派|微信公众平台|YouTube|GitHub';
// “ - 作者 | 小红书 - 你的生活指南” / “-哔哩哔哩” / “ - 知乎” at the end of a title.
const XHS_TAIL=/\s*(?:[-–—]\s*[^-–—|｜\n]{1,24}\s*)?[|｜]\s*小红书(?:\s*[-–—]\s*[^\n】」』]{1,12})?\s*$/;
const SITE_TAIL=new RegExp(`\\s*[-_|｜–—]\\s*(?:${SITES})(?:\\s*[-–—|｜]\\s*[^\\n】」』\\-–—|｜]{1,12})?\\s*$`,'i');
const AUTHOR_TAIL=/\s*[-–—|｜]\s*[^-–—|｜\n]{1,30}的(?:回答|文章|作品|笔记|视频|专栏)\s*$/;
const BOILERPLATE=[
 /复制(?:本条|这条|此条|这段|该条|此)?(?:信息|内容|链接|文字|口令)?[，,]?\s*(?:打开|去|到)\s*[【「]?[A-Za-z一-龥]{1,8}[】」]?\s*(?:App|APP|app|客户端)?\s*[，,]?\s*(?:搜索[，,]?\s*)?(?:查看|即可查看|观看|直接观看|看看)?(?:精彩内容|内容|详情|全文|视频|笔记|更多)?[。！!]?/g,
 /(?:点击|打开)链接(?:直接)?(?:打开|查看|观看)(?:精彩内容|内容|详情|全文|视频)?[。！!]?/g,
 /[^\s，。！]{0,30}发布了一篇小红书笔记[，,]?\s*快来看吧[！!]?/g,
 /😆\s*[A-Za-z0-9]{4,}\s*😆/g,
 /快来看看吧[！!]?|快来围观[！!]?|一起来看看吧[！!]?/g,
 /[【「][^】」\n]{1,30}的作品[】」]/g,
 /^\s*\d+(?:\.\d+)?\s+(?=\S)/,                 // 抖音 leading code “7.43 ”
 /(?:\s+(?:[A-Za-z]{1,4}@[A-Za-z0-9.]{2,}|\d{1,2}\/\d{1,2}|[A-Za-z0-9]{2,8}:\/))+\s*$/  // 抖音 trailing “M@w.Fu 12/01 aNY:/”
];
export function cleanUrl(raw){
 const url=raw.replace(TRAIL,'');
 try{
  const u=new URL(url);
  for(const k of [...u.searchParams.keys()])if(TRACKING.test(k))u.searchParams.delete(k);
  let out=u.toString();
  if(!u.search&&out.endsWith('?'))out=out.slice(0,-1);
  return out;
 }catch{return url;}
}
export function extractUrls(value){return [...new Set((String(value??'').match(URL_RE)||[]).map(cleanUrl).filter(u=>/^https?:\/\/[^/]+\.[^/]+/i.test(u)))];}
// Removes a trailing site/author signature, e.g. “标题 - 张三的回答 - 知乎” → “标题”.
export function cleanTitle(t){
 let out=String(t??'').trim(),prev;
 do{prev=out;out=out.replace(XHS_TAIL,'').replace(SITE_TAIL,'').replace(AUTHOR_TAIL,'').trim();}while(out!==prev&&out);
 return out;
}
// “【标题-哔哩哔哩】” occupying a whole line → “标题” (outer brackets only, nested 【硬核】 kept).
function unwrapLine(line){
 const m=line.match(/^[【「『](.*)[】」』]$/);
 if(!m)return cleanTitle(line);
 const inner=cleanTitle(m[1]);
 return inner||line;
}
export function cleanShareText(input,subject=''){
 const raw=String(input??'').replace(/\r\n?/g,'\n').trim();
 const subj=String(subject??'').trim();
 const urls=extractUrls(raw);
 if(!urls.length){const body=raw||subj;return {type:null,body,source:'',title:body,urls:[]};}
 let rest=raw;
 for(const re of BOILERPLATE)rest=rest.replace(re,' ');
 if(urls.length>1){
  // Several links: the text is the user's own note — keep it (links inline), only drop boilerplate.
  const body=rest.split('\n').map(l=>l.replace(/[ \t　]+/g,' ').trim()).filter(Boolean).join('\n');
  return {type:'link',body,source:urls[0],title:body,urls};
 }
 rest=rest.replace(URL_RE,' ');
 const lines=rest.split('\n').map(l=>l.replace(/[ \t　]+/g,' ').replace(/^[，,。:：、\s\-–—|]+|[，,:：、\s\-–—|]+$/g,'').trim()).filter(l=>l&&!/^[，,。.!！?？:：、\-–—|]+$/.test(l)).map(unwrapLine).filter(Boolean);
 let title=lines.join('\n').trim();
 if(!title&&subj&&!extractUrls(subj).length)title=unwrapLine(subj);
 return {type:'link',body:title,source:urls[0],title,urls};
}
// Clipboard hint: decide whether the clipboard text deserves a one-tap chip (never auto-fills).
export function clipboardSuggestion(clip,current={}){
 const t=String(clip??'').trim();
 if(!t||t.length>4000)return null;
 if([current.body,current.source,current.thought].some(v=>v&&String(v).includes(t)))return null;
 const urls=extractUrls(t);
 if(urls.length&&t.replace(URL_RE,'').trim().length<2)return {kind:'link',label:'填入刚复制的链接',text:urls[0]};
 if(urls.length)return {kind:'share',label:'填入刚复制的分享内容',text:t};
 return {kind:'text',label:'填入刚复制的内容',text:t};
}
