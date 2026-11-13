'use strict';
// UI theme switcher. Runs in <head> right after the theme stylesheets so the chosen theme applies before first paint.
(()=>{
 const themes=['bento','dark','aero'];let current='bento';
 try{const saved=localStorage.getItem('uiTheme');if(themes.includes(saved))current=saved;}catch{}
 // 창 조절 버튼(Windows 오버레이) 색. 각 테마 CSS의 --titlebar-bg/--titlebar-fg와 같은 값 (스타일시트 로딩 전에도 정확하도록 직접 지정)
 const TITLE={bento:['#e7e7e9','#111114'],dark:['#0e1016','#eef1f8'],aero:['#d4e7f3','#1f3a4d']};
 function syncTitleBar(){const c=TITLE[current];if(c&&window.aplay)window.aplay.call('titleBar',{color:c[0],symbol:c[1]}).catch(()=>{});}
 function apply(name){document.documentElement.dataset.theme=name;for(const n of themes){const link=document.getElementById('theme-'+n);if(link)link.disabled=n!==name;}}
 apply(current);
 document.addEventListener('DOMContentLoaded',()=>{
  const select=document.getElementById('themeSelect');if(!select)return;select.value=current;
  select.onchange=()=>{current=themes.includes(select.value)?select.value:'bento';apply(current);try{localStorage.setItem('uiTheme',current);}catch{}if(typeof updateBackToTop==='function')requestAnimationFrame(updateBackToTop);syncTitleBar();};
  syncTitleBar();
 });
})();
