'use strict';
// UI theme switcher. Runs in <head> right after the theme stylesheets so the chosen theme applies before first paint.
(()=>{
 const themes=['bento','dark','aero'];let current='bento';
 try{const saved=localStorage.getItem('uiTheme');if(themes.includes(saved))current=saved;}catch{}
 function apply(name){document.documentElement.dataset.theme=name;for(const n of themes){const link=document.getElementById('theme-'+n);if(link)link.disabled=n!==name;}}
 apply(current);
 document.addEventListener('DOMContentLoaded',()=>{
  const select=document.getElementById('themeSelect');if(!select)return;select.value=current;
  select.onchange=()=>{current=themes.includes(select.value)?select.value:'bento';apply(current);try{localStorage.setItem('uiTheme',current);}catch{}if(typeof updateBackToTop==='function')requestAnimationFrame(updateBackToTop);};
 });
})();
