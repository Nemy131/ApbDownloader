'use strict';
// In-app panel for the self-update flow (states sent from src/updater.js over 'update-state').
(()=>{
 const panel=$('updatePanel'),title=$('updateTitle'),detail=$('updateDetail'),bar=$('updateBar'),close=$('updateClose');
 let hideTimer=null;
 const mb=n=>(Number(n||0)/1048576).toFixed(1)+' MB';
 function show(s){
  clearTimeout(hideTimer);panel.hidden=false;panel.dataset.phase=s.phase;
  const v=s.version?` ${s.version}`:'';let busy=true,progress=null;
  if(s.phase==='download'){const p=s.total?s.loaded/s.total:0;progress=p;title.textContent=`업데이트${v} 다운로드 중 ${Math.floor(p*100)}%`;detail.textContent=s.total?`${mb(s.loaded)} / ${mb(s.total)}`:mb(s.loaded);}
  else if(s.phase==='extract'){title.textContent=`업데이트${v} 압축 해제 중`;detail.textContent='받은 파일을 확인하고 풀고 있습니다.';}
  else if(s.phase==='restart'){progress=1;title.textContent=`업데이트${v} 적용을 위해 다시 시작합니다`;detail.textContent='앱이 잠시 종료된 뒤 새 버전으로 자동 실행됩니다. data 폴더는 유지됩니다.';}
  else if(s.phase==='done'){busy=false;progress=1;title.textContent=`${s.version} 버전으로 업데이트되었습니다`;detail.textContent='로그인 정보·기록·북마크·설정은 그대로 유지됩니다.';hideTimer=setTimeout(()=>{panel.hidden=true;},8000);}
  else if(s.phase==='error'){busy=false;title.textContent=`업데이트${v} 실패`;detail.textContent=(s.message||'알 수 없는 오류')+' · 기존 버전은 그대로 사용할 수 있습니다.';}
  close.hidden=busy;
  if(progress==null){bar.removeAttribute('value');}else{bar.value=Math.max(0,Math.min(1,progress));}
  bar.hidden=s.phase==='error'||s.phase==='done';
 }
 close.onclick=()=>{clearTimeout(hideTimer);panel.hidden=true;};
 window.aplay.onUpdate(show);
})();
