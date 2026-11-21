'use strict';
const input=document.getElementById('token'),msg=document.getElementById('msg'),save=document.getElementById('save'),cancel=document.getElementById('cancel');
async function submit(){
 const value=input.value.trim();if(!value){msg.textContent='请先粘贴令牌';return;}
 save.disabled=true;msg.dataset.ok='';msg.textContent='正在向云端验证…';
 try{const r=await window.tokenPrompt.submit(value);if(r&&r.ok){msg.dataset.ok='true';msg.textContent='已保存，正在首次同步';input.value='';return;}msg.textContent=(r&&r.error)||'保存失败';}
 catch(e){msg.textContent='保存失败：'+e.message;}
 save.disabled=false;
}
save.onclick=submit;cancel.onclick=()=>window.close();
input.addEventListener('keydown',e=>{if(e.key==='Enter')void submit();if(e.key==='Escape')window.close();});
