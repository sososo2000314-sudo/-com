
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
let token = localStorage.getItem('jc_token') || '';
let me = null;
let currentPage = 'home';
let previousPage = 'home';
let authMode = 'login';
let mailbox = 'inbox';
let postsCache = [];

async function api(path, options={}) {
  const headers = {'Content-Type':'application/json', ...(options.headers||{})};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {...options, headers});
  const data = await res.json().catch(()=>({error:'サーバーから正しい応答がありません'}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}
function escapeHtml(value='') { return String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2600); }
function showMessage(selector, message, error=false) { const el=$(selector); if(el){el.textContent=message;el.style.color=error?'var(--danger)':'var(--muted)';} }
function switchPage(name) {
  if(name==='settings') { if(currentPage!=='settings') previousPage=currentPage; }
  currentPage=name;
  $$('.page').forEach(p=>p.classList.toggle('active-page',p.id===`${name}Page`));
  $$('.nav-button').forEach(b=>b.classList.toggle('active',b.dataset.go===name));
  $('#settingsToggle').textContent=name==='settings'?'↩ 戻る':'⚙ 設定';
  window.scrollTo({top:0,behavior:'smooth'});
  if(name==='home') loadPosts('homePosts');
  if(name==='mychannel') loadPosts('myPosts', true);
  if(name==='mail') loadMail();
}
function toggleSettings(){ if(currentPage==='settings') switchPage(previousPage||'home'); else switchPage('settings'); }
function authScreen(isLoggedIn) { $('#authView').classList.toggle('hidden',isLoggedIn); $('#mainView').classList.toggle('hidden',!isLoggedIn); $('#bottomNav').classList.toggle('hidden',!isLoggedIn); $('#whoami').textContent=isLoggedIn?(me?.display_name||me?.username||''):''; }
function renderPost(post) {
  const liked=post.liked_by_me;
  const kindLabels={text:'文章',image:'画像・GIF',video_vertical:'縦動画',video_horizontal:'横動画',file:'ファイル・書類',url:'URL'};
  const body=escapeHtml(post.body||'');
  const url=post.url?`<p><a class="inline-link" href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(post.url)}</a></p>`:'';
  return `<article class="post-card"><div class="post-meta"><span>${escapeHtml(post.display_name||post.username)} · ${escapeHtml(kindLabels[post.kind]||'投稿')}</span><span>${escapeHtml(post.created_at||'')}</span></div><h3>${escapeHtml(post.title||'（タイトルなし）')}</h3>${body?`<p>${body}</p>`:''}${url}<div class="post-meta"><span>♥ ${post.likes_count||0}　コメント ${post.comments_count||0}</span><span>${post.username===me?.username?'自分の投稿':''}</span></div><div class="post-actions"><button data-like="${post.id}" class="${liked?'liked':''}">${liked?'♥ いいね済み':'♡ いいね'}</button><button data-comment="${post.id}">コメント</button><button data-share="${post.id}">共有</button>${post.username===me?.username?`<button data-delete-post="${post.id}">削除</button>`:''}</div><div class="comments" id="comments-${post.id}"></div></article>`;
}
async function loadPosts(targetId, ownOnly=false) {
  const target=$(`#${targetId}`); if(!target) return;
  target.innerHTML='<div class="empty">読み込み中…</div>';
  try {
    const data=await api('/posts'); postsCache=data.posts||[];
    const items=ownOnly?postsCache.filter(p=>p.username===me?.username):postsCache;
    target.innerHTML=items.length?items.map(renderPost).join(''):'<div class="empty">まだ投稿がありません。マイチャンネルから最初の投稿を作ろう！</div>';
  } catch(e){target.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`;}
}
async function refreshVisiblePosts(){ await Promise.all([loadPosts('homePosts'),loadPosts('myPosts',true)]); }
async function loadMail(){
  const target=$('#mailList');target.innerHTML='<div class="empty">読み込み中…</div>';
  try{
    const data=await api(`/mail?box=${mailbox}`); const items=data.messages||[];
    target.innerHTML=items.length?items.map(m=>`<article class="mail-card ${m.is_read?'':'unread'}"><div class="post-meta"><span>${mailbox==='inbox'?'送信者':'宛先'}：${escapeHtml(mailbox==='inbox'?m.from_username:m.to_username)}</span><span>${escapeHtml(m.created_at||'')}</span></div><h3>${escapeHtml(m.subject||'（件名なし）')}</h3><p class="mail-body">${escapeHtml(m.body)}</p><div class="post-actions">${mailbox==='inbox'&&!m.is_read?`<button data-read-mail="${m.id}">既読にする</button>`:''}<button data-delete-mail="${m.id}">削除</button></div></article>`).join(''):'<div class="empty">メッセージはありません。</div>';
  }catch(e){target.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`;}
}
async function loadUsers(query){
  const target=$('#userResults');target.innerHTML='<div class="empty">検索中…</div>';
  try{const data=await api(`/users?q=${encodeURIComponent(query)}`);const users=data.users||[];target.innerHTML=users.length?users.map(u=>`<article class="user-card"><div><strong>${escapeHtml(u.display_name||u.username)}</strong><p class="muted">@${escapeHtml(u.username)}</p></div><button class="button" data-message-user="${escapeHtml(u.username)}">メールする</button></article>`).join(''):'<div class="empty">アカウントが見つかりません。</div>';}catch(e){target.innerHTML=`<div class="empty">${escapeHtml(e.message)}</div>`;}
}
function setAuthMode(mode){authMode=mode;$$('[data-auth-mode]').forEach(b=>b.classList.toggle('active',b.dataset.authMode===mode));$('#displayNameLabel').classList.toggle('hidden',mode!=='register');$('#authSubmit').textContent=mode==='login'?'ログイン':'アカウントを作成';$('#authForm').elements.password.autocomplete=mode==='login'?'current-password':'new-password';showMessage('#authMessage','');}
async function boot(){
  const theme=localStorage.getItem('jc_theme')||'system';applyTheme(theme);document.body.dataset.font=localStorage.getItem('jc_font')||'normal';$('#themeSelect').value=theme;$('#fontSelect').value=document.body.dataset.font;
  if(!token){authScreen(false);return;}
  try{const data=await api('/me');me=data.user;authScreen(true);$('#settingsDisplayName').value=me.display_name||'';await refreshVisiblePosts();}
  catch{token='';localStorage.removeItem('jc_token');authScreen(false);}
}
function applyTheme(theme){localStorage.setItem('jc_theme',theme);if(theme==='system')document.body.removeAttribute('data-theme');else document.body.dataset.theme=theme;}

$$('[data-auth-mode]').forEach(b=>b.addEventListener('click',()=>setAuthMode(b.dataset.authMode)));
$('#authForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const payload={username:f.get('username').trim(),password:f.get('password'),display_name:f.get('display_name')||''};try{const data=await api(authMode==='register'?'/register':'/login',{method:'POST',body:JSON.stringify(payload)});token=data.token;localStorage.setItem('jc_token',token);me=data.user;authScreen(true);$('#settingsDisplayName').value=me.display_name||'';showMessage('#authMessage','');toast(authMode==='register'?'アカウントを作成しました':'ログインしました');await refreshVisiblePosts();switchPage('home');}catch(err){showMessage('#authMessage',err.message,true);}});
$('#settingsToggle').addEventListener('click',toggleSettings);
$$('[data-go]').forEach(b=>b.addEventListener('click',()=>switchPage(b.dataset.go)));
$$('[data-go-last]').forEach(b=>b.addEventListener('click',()=>switchPage(previousPage||'home')));
$('#postKind').addEventListener('change',()=>{const kind=$('#postKind').value;$('#urlField').classList.toggle('hidden',kind!=='url');$('#fileField').classList.toggle('hidden',!['image','video_vertical','video_horizontal','file'].includes(kind));$('#fileHint').classList.toggle('hidden',!['image','video_vertical','video_horizontal','file'].includes(kind));});
$('#postForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);const attachment=f.get('attachment');const payload={kind:f.get('kind'),title:f.get('title').trim(),body:f.get('body').trim(),url:f.get('url').trim()};if(attachment&&attachment.size>0){showMessage('#postMessage','選択したファイル本体はまだアップロードされません。タイトル・説明・投稿種類のみ保存します。');}try{await api('/posts',{method:'POST',body:JSON.stringify(payload)});e.currentTarget.reset();$('#postKind').dispatchEvent(new Event('change'));showMessage('#postMessage','投稿しました');await refreshVisiblePosts();switchPage('mychannel');}catch(err){showMessage('#postMessage',err.message,true);}});
$('#mailForm').addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/mail',{method:'POST',body:JSON.stringify({to_username:f.get('to').trim(),subject:f.get('subject').trim(),body:f.get('body').trim()})});e.currentTarget.reset();showMessage('#mailMessage','送信しました');mailbox='sent';$$('[data-mailbox]').forEach(b=>b.classList.toggle('active',b.dataset.mailbox===mailbox));await loadMail();}catch(err){showMessage('#mailMessage',err.message,true);}});
$$('[data-mailbox]').forEach(b=>b.addEventListener('click',()=>{mailbox=b.dataset.mailbox;$$('[data-mailbox]').forEach(x=>x.classList.toggle('active',x===b));loadMail();}));
$('#searchForm').addEventListener('submit',async e=>{e.preventDefault();const q=new FormData(e.currentTarget).get('q').trim().toLowerCase();const target=$('#searchResults');if(!q){target.innerHTML='<div class="empty">キーワードを入力してください。</div>';return;}try{const data=await api('/posts');const results=(data.posts||[]).filter(p=>`${p.title} ${p.body} ${p.username} ${p.display_name}`.toLowerCase().includes(q));target.innerHTML=results.length?results.map(renderPost).join(''):'<div class="empty">該当する投稿はありません。</div>';}catch(err){target.innerHTML=`<div class="empty">${escapeHtml(err.message)}</div>`;}});
$('#userSearchForm').addEventListener('submit',e=>{e.preventDefault();loadUsers(new FormData(e.currentTarget).get('q').trim());});
$('#themeSelect').addEventListener('change',e=>applyTheme(e.target.value));$('#fontSelect').addEventListener('change',e=>{document.body.dataset.font=e.target.value;localStorage.setItem('jc_font',e.target.value);});
$('#saveProfile').addEventListener('click',async()=>{try{const data=await api('/me',{method:'PATCH',body:JSON.stringify({display_name:$('#settingsDisplayName').value.trim()})});me=data.user;$('#whoami').textContent=me.display_name||me.username;toast('表示名を保存しました');}catch(e){toast(e.message);}});
$('#logoutButton').addEventListener('click',async()=>{try{await api('/logout',{method:'POST',body:'{}'});}catch{}token='';me=null;localStorage.removeItem('jc_token');authScreen(false);switchPage('home');toast('ログアウトしました');});
document.addEventListener('click',async e=>{
 const like=e.target.closest('[data-like]');if(like){try{await api(`/posts/${like.dataset.like}/like`,{method:'POST',body:'{}'});await refreshVisiblePosts();}catch(err){toast(err.message);}return;}
 const del=e.target.closest('[data-delete-post]');if(del&&confirm('この投稿を削除しますか？')){try{await api(`/posts/${del.dataset.deletePost}`,{method:'DELETE'});await refreshVisiblePosts();toast('投稿を削除しました');}catch(err){toast(err.message);}return;}
 const comment=e.target.closest('[data-comment]');if(comment){const body=prompt('コメントを入力してください');if(body&&body.trim()){try{await api(`/posts/${comment.dataset.comment}/comments`,{method:'POST',body:JSON.stringify({body:body.trim()})});toast('コメントしました');}catch(err){toast(err.message);}}return;}
 const share=e.target.closest('[data-share]');if(share){const url=`${location.origin}/#post-${share.dataset.share}`;try{await navigator.clipboard.writeText(url);toast('投稿リンクをコピーしました');}catch{prompt('このリンクをコピーしてください',url);}return;}
 const read=e.target.closest('[data-read-mail]');if(read){try{await api(`/mail/${read.dataset.readMail}/read`,{method:'POST',body:'{}'});await loadMail();}catch(err){toast(err.message);}return;}
 const delMail=e.target.closest('[data-delete-mail]');if(delMail&&confirm('このメッセージを削除しますか？')){try{await api(`/mail/${delMail.dataset.deleteMail}`,{method:'DELETE'});await loadMail();}catch(err){toast(err.message);}return;}
 const msgUser=e.target.closest('[data-message-user]');if(msgUser){switchPage('mail');$('#mailForm').elements.to.value=msgUser.dataset.messageUser;$('#mailForm').elements.body.focus();}
});
setAuthMode('login');boot();
