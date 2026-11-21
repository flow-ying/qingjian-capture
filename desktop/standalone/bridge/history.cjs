'use strict';
const {UUID,inspectBlockContent}=require('../core.cjs');

// Only inspect paths already owned by capture receipts, never scan the Vault.
async function inspectRecords(app,receipts,ids){
 if(!Array.isArray(ids)||ids.length>100||ids.some(id=>!UUID.test(id)))throw Error('历史查询无效');
 const cache=new Map(),results=[];
 for(const id of ids){
  const receipt=receipts[id];
  if(!receipt){results.push({id,state:'unknown'});continue;}
  const target=receipt.path;
  if(!cache.has(target))cache.set(target,(async()=>{
   try{
    const file=app.vault.getAbstractFileByPath(target);
    if(!file)return {missing:true};
    const content=(await app.vault.read(file)).replace(/\r\n/g,'\n');
    const dirty=app.workspace.getLeavesOfType('markdown').some(leaf=>leaf.view.file?.path===target&&leaf.view.editor&&leaf.view.editor.getValue().replace(/\r\n/g,'\n')!==content);
    return dirty?{unknown:true}:{content};
   }catch{return {unknown:true};}
  })());
  const source=await cache.get(target);
  let state='unknown';
  if(source.missing)state='missing';
  else if(!source.unknown)state=inspectBlockContent(source.content,id,receipt.type);
  results.push({id,state,path:target,revision:receipt.revision});
 }
 return results;
}
module.exports={inspectRecords};
