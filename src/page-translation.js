'use strict';
function collect(limit=12){
 if(/login|register|password|account|message|chat/i.test(location.pathname))return [];
 const state=window.__aplayTranslation ||= {nodes:new Map(),next:0};
 for(const [id,r] of state.nodes)if(!r.node.isConnected)state.nodes.delete(id);
 const known=new Map([...state.nodes].map(([id,r])=>[r.node,{id,r}]));
 const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),out=[];let node;
 while((node=walk.nextNode())&&out.length<limit){
  const parent=node.parentElement;if(!parent||parent.closest('script,style,noscript,textarea,input,select,option,code,pre,[contenteditable],.el-dialog,[role="dialog"],[class*="captcha"],[class*="Captcha"],[class*="login"],[class*="password"],[class*="verify"],[class*="verification"],[class*="geetest"],[class*="account"],[class*="message"]'))continue;
  const rect=parent.getBoundingClientRect();if(!rect.width||!rect.height||rect.bottom<0||rect.top>innerHeight||rect.right<0||rect.left>innerWidth||getComputedStyle(parent).visibility==='hidden')continue;
  const value=node.nodeValue;if(!/[\u3400-\u9fff]/u.test(value)||/[\u3040-\u30ff]/u.test(value)||value.length>1800)continue;
  const old=known.get(node);if(old&&value===old.r.translated)continue;
  const id=old?.id||++state.next;const r={node,original:value,translated:null};state.nodes.set(id,r);out.push({id,text:value});
 }
 return out;
}
function apply(items){const state=window.__aplayTranslation;if(!state)return;for(const item of items){const r=state.nodes.get(item.id);if(r&&r.node.isConnected&&r.original===item.original&&r.node.nodeValue===r.original){r.node.nodeValue=item.text;r.translated=item.text;}}}
function restore(){const state=window.__aplayTranslation;if(!state)return;for(const r of state.nodes.values())if(r.node.isConnected&&r.translated===r.node.nodeValue)r.node.nodeValue=r.original;delete window.__aplayTranslation;}
module.exports={collect,apply,restore};
