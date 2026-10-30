/* Pilotage financier — logique métier côté client.
   Les montants sont convertis en unités mineures entières avant calcul.
   La base SQL reste l'autorité pour les écritures et soldes définitifs. */
(() => {
"use strict";
const $ = id => document.getElementById(id);
const today = new Date().toISOString().slice(0,10);
const client = window.createSupabaseClient();
let wallets = [], transactions = [], draftReady = false, cashflowChart = null, expenseChart = null;
const currencyDigits = {MGA:0, USD:2, EUR:2};
const fmt = (minor, currency="MGA") => new Intl.NumberFormat("fr-FR",{style:"currency",currency,maximumFractionDigits:currencyDigits[currency] ?? 2}).format(fromMinor(minor,currency));
function toMinor(value,currency="MGA"){
  const n = Number(value);
  if(!Number.isFinite(n)) throw new Error("Montant invalide.");
  const factor = 10 ** (currencyDigits[currency] ?? 2);
  const result = Math.round((n + Number.EPSILON) * factor);
  if(!Number.isSafeInteger(result)) throw new Error("Montant trop élevé.");
  return result;
}
function fromMinor(value,currency="MGA"){return Number(value)/(10 ** (currencyDigits[currency] ?? 2));}
function escapeHtml(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function toast(message,error=false){const el=document.createElement("div");el.className="toast"+(error?" error":"");el.textContent=message;$("toastHost").append(el);setTimeout(()=>el.remove(),3600);}
function setStatus(text,kind=""){const el=$("connectionStatus");el.textContent=text;el.className="connection-pill "+kind;}
function showPage(name){document.querySelectorAll(".page").forEach(p=>p.classList.toggle("active",p.id==="page-"+name));document.querySelectorAll(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.page===name));window.scrollTo({top:0,behavior:"smooth"});}
function dateStart(days){const d=new Date();d.setDate(d.getDate()-days);return d.toISOString().slice(0,10);}
function txNature(t){return ({expense:"Dépense",income:"Revenu",transfer:"Transfert",loan_received:"Emprunt reçu",loan_given:"Prêt accordé",capital_contribution:"Apport en capital",debt_repayment:"Remboursement",opening_balance:"Solde initial"})[t]||t;}
function amountFor(tx){return Number(tx.amount_minor ?? toMinor(tx.amount,tx.currency||"MGA"));}
function validDraft(d){
  const errors=[];
  if(!d.type) errors.push("Choisissez une nature économique.");
  if(!Number.isSafeInteger(d.amount_minor)||d.amount_minor<=0) errors.push("Le montant doit être supérieur à zéro.");
  if(!d.date) errors.push("La date est obligatoire.");
  if(!d.description.trim()) errors.push("La description est obligatoire.");
  if(d.type==="transfer" && (!d.source_wallet_id||!d.destination_wallet_id)) errors.push("Un transfert exige un portefeuille source et un portefeuille destination.");
  if(d.type==="transfer" && d.source_wallet_id===d.destination_wallet_id) errors.push("Un transfert doit relier deux portefeuilles différents.");
  if(["expense","loan_given","debt_repayment"].includes(d.type)&&!d.source_wallet_id) errors.push("Le portefeuille source est obligatoire.");
  if(["income","loan_received","capital_contribution","opening_balance"].includes(d.type)&&!d.destination_wallet_id) errors.push("Le portefeuille de destination est obligatoire.");
  return errors;
}
function readDraft(){
  const currency=$("txCurrency").value;
  return {type:$("txType").value,amount_minor:toMinor($("txAmount").value,currency),currency,date:$("txDate").value,source_wallet_id:$("txSource").value||null,destination_wallet_id:$("txDestination").value||null,category:$("txCategory").value.trim(),company:$("txCompany").value.trim(),activity:$("txActivity").value.trim(),counterparty:$("txCounterparty").value.trim(),description:$("txDescription").value.trim()};
}
function updateDraftState(){
  try{const errors=validDraft(readDraft());draftReady=errors.length===0;$("formErrors").hidden=!errors.length;$("formErrors").innerHTML=errors.map(escapeHtml).join("<br>");}
  catch(e){draftReady=false;$("formErrors").hidden=false;$("formErrors").textContent=e.message;}
  $("validateTransaction").disabled=!draftReady;
  $("draftBadge").textContent=draftReady?"Prêt à vérifier":"Brouillon";
  $("draftBadge").className="tag "+(draftReady?"":"neutral");
}
function resetForm(){ $("transactionForm").reset();$("txDate").value=today;$("txId").value="";$("formErrors").hidden=true;draftReady=false;$("validateTransaction").disabled=true;$("draftBadge").textContent="Brouillon"; }
function populateWalletSelects(){
  for(const id of ["txSource","txDestination"]){const sel=$(id),old=sel.value;sel.innerHTML='<option value="">Non renseigné</option>'+wallets.filter(w=>w.is_active!==false).map(w=>`<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)} (${w.currency})</option>`).join("");if(old)sel.value=old;}
}
async function loadWallets(){
  if(!client)return;
  const {data,error}=await client.from("wallets").select("id,name,currency,is_active,opening_balance_minor,opening_date").order("name");
  if(error)throw error;wallets=data||[];populateWalletSelects();renderWallets();
}
async function loadTransactions(){
  if(!client)return;
  const {data,error}=await client.from("transactions").select("id,type,amount_minor,currency,transaction_date,description,category,source_wallet_id,destination_wallet_id,company_name,activity_name,status,created_at").eq("status","validated").order("transaction_date",{ascending:false}).limit(1000);
  if(error)throw error;transactions=data||[];renderTransactions();renderWallets();renderDashboard();renderPerformance();renderControl();
}
function renderTransactions(){
  const q=$("transactionSearch").value.toLowerCase();
  const list=transactions.filter(t=>[t.description,t.category,t.company_name,t.activity_name,txNature(t.type)].join(" ").toLowerCase().includes(q));
  $("transactionRows").innerHTML=list.length?list.map(t=>{const w=wallets.find(x=>x.id===t.source_wallet_id)||wallets.find(x=>x.id===t.destination_wallet_id);const sign=["income","loan_received","capital_contribution","opening_balance"].includes(t.type)?"+":(["expense","loan_given","debt_repayment"].includes(t.type)?"−":"↔");return `<div class="transaction-row"><div class="activity-icon">${sign==="+"?"↗":sign==="−"?"↙":"⇄"}</div><div class="transaction-meta"><strong>${escapeHtml(t.description)}</strong><small>${escapeHtml(t.transaction_date)} · ${escapeHtml(txNature(t.type))} · ${escapeHtml(w?.name||"—")}</small></div><div class="transaction-sum ${sign==="+"?"positive":sign==="−"?"negative":""}">${sign==="↔"?"":sign}${fmt(amountFor(t),t.currency)}</div></div>`}).join(""):'<div class="empty-state">Aucune transaction trouvée.</div>';
  $("recentTransactions").innerHTML=transactions.slice(0,5).map(t=>{const positive=["income","loan_received","capital_contribution","opening_balance"].includes(t.type);return `<div class="activity-row"><div class="activity-icon">${positive?"↗":t.type==="transfer"?"⇄":"↙"}</div><div class="activity-main"><strong>${escapeHtml(t.description)}</strong><small>${escapeHtml(txNature(t.type))} · ${escapeHtml(t.transaction_date)}</small></div><span class="activity-amount ${positive?"positive":t.type==="expense"?"negative":""}">${positive?"+":t.type==="expense"?"−":""}${fmt(amountFor(t),t.currency)}</span></div>`}).join("")||'<div class="empty-state">Aucune opération validée.</div>';
}
function renderDashboard(){
  const days=Number($("periodDays").value),start=dateStart(days);
  const inTypes=["income","loan_received","capital_contribution","opening_balance"];
  const outTypes=["expense","loan_given","debt_repayment"];
  const inTx=transactions.filter(t=>t.transaction_date>=start&&inTypes.includes(t.type));
  const outTx=transactions.filter(t=>t.transaction_date>=start&&outTypes.includes(t.type));
  const sum=(arr,cur)=>arr.filter(t=>t.currency===cur).reduce((s,t)=>s+amountFor(t),0);
  const cashByCurrency={};wallets.forEach(w=>cashByCurrency[w.currency]=(cashByCurrency[w.currency]||0)+Number(w.calculated_balance_minor??w.opening_balance_minor??0));
  $("kpiCash").textContent=Object.entries(cashByCurrency).map(([c,v])=>fmt(v,c)).join(" · ")||"—";
  const cur="MGA";$("kpiIn").textContent=fmt(sum(inTx,cur),cur);$("kpiOut").textContent=fmt(sum(outTx,cur),cur);
  const income=transactions.filter(t=>t.currency===cur&&t.type==="income"&&t.transaction_date>=start).reduce((s,t)=>s+amountFor(t),0);
  const expense=transactions.filter(t=>t.currency===cur&&t.type==="expense"&&t.transaction_date>=start).reduce((s,t)=>s+amountFor(t),0);
  $("kpiResult").textContent=fmt(income-expense,cur);$("kpiResult").className="result-chip";
  renderCashflowChart(days);renderExpenseChart();
}
function renderCashflowChart(days){
  const canvas=$("cashflowChart");if(!canvas||!window.Chart)return;
  const end=new Date(),months=Math.min(12,Math.max(1,Math.ceil(days/30)));
  const labels=[],incoming=[],outgoing=[];
  for(let i=months-1;i>=0;i--){const d=new Date(end.getFullYear(),end.getMonth()-i,1);const key=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0");labels.push(d.toLocaleDateString("fr-FR",{month:"short"}));const monthTx=transactions.filter(t=>String(t.transaction_date).slice(0,7)===key&&t.currency==="MGA");incoming.push(monthTx.filter(t=>["income","loan_received","capital_contribution","opening_balance"].includes(t.type)).reduce((s,t)=>s+amountFor(t),0));outgoing.push(monthTx.filter(t=>["expense","loan_given","debt_repayment"].includes(t.type)).reduce((s,t)=>s+amountFor(t),0));}
  if(cashflowChart)cashflowChart.destroy();
  cashflowChart=new Chart(canvas,{type:"bar",data:{labels,datasets:[{label:"Entrées",data:incoming,backgroundColor:"#71e0c1",borderRadius:5,borderSkipped:false},{label:"Sorties",data:outgoing,backgroundColor:"#df8b82",borderRadius:5,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:"#172728",titleColor:"#edf6f2",bodyColor:"#edf6f2",callbacks:{label:c=>c.dataset.label+": "+fmt(c.raw,"MGA")}}},scales:{x:{grid:{display:false},ticks:{color:"#789088",font:{size:9}}},y:{beginAtZero:true,grid:{color:"rgba(211,238,229,.07)"},ticks:{color:"#789088",font:{size:8},callback:v=>v>=1000000?(v/1000000).toFixed(1)+"M":v>=1000?(v/1000).toFixed(0)+"k":v}}}}});
}
function renderExpenseChart(){
  const canvas=$("expenseChart");if(!canvas||!window.Chart)return;
  const totals=new Map();transactions.filter(t=>t.type==="expense"&&t.currency==="MGA").forEach(t=>{const k=t.category||"Non catégorisé";totals.set(k,(totals.get(k)||0)+amountFor(t));});
  const rows=[...totals].sort((a,b)=>b[1]-a[1]).slice(0,6);const labels=rows.map(x=>x[0]),values=rows.map(x=>x[1]);
  if(expenseChart)expenseChart.destroy();
  if(!rows.length){$("expenseLegend").innerHTML='<div class="empty-state">Aucune dépense catégorisée en MGA.</div>';return;}
  const colors=["#71e0c1","#6e9de8","#e5a16f","#bd91e8","#df8b82","#a9c1b7"];
  expenseChart=new Chart(canvas,{type:"doughnut",data:{labels,datasets:[{data:values,backgroundColor:colors,borderColor:"#111f20",borderWidth:4,hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:"70%",plugins:{legend:{display:false},tooltip:{backgroundColor:"#172728",callbacks:{label:c=>c.label+": "+fmt(c.raw,"MGA")}}}}});
  const total=values.reduce((a,b)=>a+b,0);$("expenseLegend").innerHTML=rows.map(([name,value],i)=>`<div class="category-row"><span class="category-name"><i class="category-swatch" style="background:${colors[i]}"></i>${escapeHtml(name)}</span><strong>${total?Math.round(value/total*100):0}% · ${fmt(value,"MGA")}</strong></div>`).join("");
}
function renderWallets(){
  $("walletRows").innerHTML=wallets.map(w=>{const opening=Number(w.opening_balance_minor||0),rows=transactions.filter(t=>t.currency===w.currency),ins=rows.filter(t=>t.destination_wallet_id===w.id).reduce((s,t)=>s+amountFor(t),0),outs=rows.filter(t=>t.source_wallet_id===w.id).reduce((s,t)=>s+amountFor(t),0),bal=opening+ins-outs;w.calculated_balance_minor=bal;return `<div class="wallet-card"><div><strong>${escapeHtml(w.name)}</strong><small>${escapeHtml(w.currency)} · ${w.is_active===false?"Inactif":"Actif"}</small></div><div class="wallet-balance">${fmt(bal,w.currency)}</div></div>`}).join("")||'<div class="empty-state">Aucun portefeuille enregistré.</div>';
  renderDashboard();
}
function renderPerformance(){
  const map=new Map();transactions.filter(t=>t.type==="income"||t.type==="expense").forEach(t=>{const key=t.activity_name||"Activité non affectée";const row=map.get(key)||{income:0,expense:0,currency:t.currency};if(row.currency===t.currency){if(t.type==="income")row.income+=amountFor(t);else row.expense+=amountFor(t);}map.set(key,row);});
  $("performanceContent").innerHTML=[...map].map(([name,v])=>`<div class="performance-row"><strong>${escapeHtml(name)}</strong><span>Revenus ${fmt(v.income,v.currency)} · Dépenses ${fmt(v.expense,v.currency)}<br>Résultat simplifié <b>${fmt(v.income-v.expense,v.currency)}</b></span></div>`).join("")||'<div class="empty-state">Aucune donnée de performance.</div>';
  renderExpenseChart();
}
function renderControl(){
  const issues=[];const seen=new Set();
  transactions.forEach(t=>{const k=[t.transaction_date,t.amount_minor,t.currency,t.type,(t.description||"").toLowerCase()].join("|");if(seen.has(k))issues.push("Doublon potentiel : "+t.description+" ("+t.transaction_date+").");seen.add(k);if(!t.description)issues.push("Transaction sans description : "+t.id);if(t.type==="transfer"&&(!t.source_wallet_id||!t.destination_wallet_id))issues.push("Transfert incomplet : "+t.id);});
  $("controlIssues").innerHTML=issues.length?issues.map(x=>`<div class="issue-row">⚠ ${escapeHtml(x)}</div>`).join(""):'<div class="empty-state">✓ Aucune anomalie simple détectée dans les transactions chargées.</div>';
}
async function createTransaction(d){
  const errors=validDraft(d);if(errors.length)throw new Error(errors.join(" "));
  if(!client)throw new Error("Supabase n'est pas configuré. Complétez supabase.js.");
  const {data:auth}=await client.auth.getSession();
  if(!auth?.session)throw new Error("Connexion requise : activez Supabase Auth avant les écritures.");
  const payload={p_type:d.type,p_amount_minor:d.amount_minor,p_currency:d.currency,p_transaction_date:d.date,p_description:d.description,p_category:d.category||null,p_source_wallet_id:d.source_wallet_id,p_destination_wallet_id:d.destination_wallet_id,p_company_name:d.company||null,p_activity_name:d.activity||null,p_counterparty_name:d.counterparty||null,p_idempotency_key:crypto.randomUUID()};
  const {data,error}=await client.rpc("create_financial_transaction",payload);
  if(error)throw error;return data;
}
async function handleTransactionSubmit(e){e.preventDefault();try{const d=readDraft();const errs=validDraft(d);if(errs.length)throw new Error(errs.join(" "));if(!confirm(`Confirmer l'enregistrement de ${fmt(d.amount_minor,d.currency)} — ${txNature(d.type)} ?`))return;$("validateTransaction").disabled=true;await createTransaction(d);toast("Transaction enregistrée.");resetForm();await refreshAll();}catch(err){toast(err.message||"Erreur d'enregistrement.",true);updateDraftState();}}
async function createWallet(e){e.preventDefault();try{if(!client)throw new Error("Supabase n'est pas configuré.");const {data:auth}=await client.auth.getSession();if(!auth?.session)throw new Error("Connexion requise avant de créer un portefeuille.");const currency=$("walletCurrency").value;const {error}=await client.from("wallets").insert({name:$("walletName").value.trim(),currency,opening_balance_minor:toMinor($("walletOpening").value||0,currency),opening_date:$("walletDate").value,is_active:true});if(error)throw error;toast("Portefeuille créé.");$("walletForm").reset();await refreshAll();}catch(err){toast(err.message,true);}}
async function sendToAssistant(){
  const message=$("chatInput").value.trim();if(!message)return;
  appendChat(message,"user");$("chatInput").value="";$("chatSend").disabled=true;
  try{
    if(!client)throw new Error("Configurez d'abord Supabase dans supabase.js.");
    const {data:sessionData,error:sessionError}=await client.auth.getSession();
    if(sessionError)throw sessionError;
    const session=sessionData?.session;if(!session)throw new Error("Connectez-vous à votre espace avant d'utiliser l'assistant.");
    const endpoint=window.APP_CONFIG.SUPABASE_URL.replace(/\/$/,"")+"/functions/v1/financial-assistant";
    const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+session.access_token,"apikey":window.APP_CONFIG.SUPABASE_ANON_KEY},body:JSON.stringify({message,today:new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,10),wallets:wallets.filter(w=>w.is_active!==false).map(w=>({id:w.id,name:w.name,currency:w.currency})),currencies:["MGA","USD","EUR"]})});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||"Assistant indisponible ("+response.status+").");
    const result=payload.result||payload;
    if(result.action==="fill_transaction"||result.action==="clarify"){
      applyAssistantDraft(result.transaction||{});
      showPage("transactions");
      appendChat(result.reply||"J'ai préparé un brouillon. Vérifiez les champs avant de l'enregistrer.","assistant");
    }else if(result.action==="query_finances"){
      appendChat(answerFinanceQuery(result.query||{}),"assistant");
    }else{
      appendChat(result.reply||"Je peux préparer une transaction ou répondre à une question sur les données chargées.","assistant");
    }
  }catch(err){appendChat("Je n'ai pas pu traiter cette demande : "+err.message,"assistant");}
  finally{$("chatSend").disabled=false;}
}
function normalizeText(s){return String(s||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").trim().toLowerCase();}
function applyAssistantDraft(d){
  if(d.type)$("txType").value=d.type;
  if(d.amount!==null&&d.amount!==undefined&&Number.isFinite(Number(d.amount))) $("txAmount").value=String(d.amount);
  if(["MGA","USD","EUR"].includes(d.currency))$("txCurrency").value=d.currency;
  if(d.date&&/^\d{4}-\d{2}-\d{2}$/.test(d.date))$("txDate").value=d.date;
  if(d.description!==null&&d.description!==undefined)$("txDescription").value=d.description;
  if(d.category!==null&&d.category!==undefined)$("txCategory").value=d.category;
  if(d.company!==null&&d.company!==undefined)$("txCompany").value=d.company;
  if(d.activity!==null&&d.activity!==undefined)$("txActivity").value=d.activity;
  if(d.counterparty!==null&&d.counterparty!==undefined)$("txCounterparty").value=d.counterparty;
  const namedWallet=wallets.find(w=>normalizeText(w.name)===normalizeText(d.wallet_name));
  const destination=wallets.find(w=>normalizeText(w.name)===normalizeText(d.destination_wallet_name));
  const incoming=["income","loan_received","capital_contribution","opening_balance"].includes(d.type);
  if(namedWallet){if(incoming)$("txDestination").value=namedWallet.id;else $("txSource").value=namedWallet.id;}
  if(destination)$("txDestination").value=destination.id;
  updateDraftState();
  if(d.wallet_name&&!namedWallet)appendChat("Je n'ai pas trouvé le portefeuille « "+d.wallet_name+" ». Choisissez-le dans le formulaire.","assistant");
  if(d.destination_wallet_name&&!destination)appendChat("Je n'ai pas trouvé le portefeuille « "+d.destination_wallet_name+" ». Choisissez-le dans le formulaire.","assistant");
}
function answerFinanceQuery(q){
  const start=q.start_date||"0000-01-01",end=q.end_date||"9999-12-31",currency=q.currency||"MGA";
  let rows=transactions.filter(t=>t.transaction_date>=start&&t.transaction_date<=end&&(!q.category||normalizeText(t.category)===normalizeText(q.category))&&(!q.wallet_name||[t.source_wallet_id,t.destination_wallet_id].some(id=>normalizeText(wallets.find(w=>w.id===id)?.name)===normalizeText(q.wallet_name))));
  const money=(n,c=currency)=>fmt(n,c);
  if(q.kind==="balance"){
    const selected=wallets.filter(w=>!q.wallet_name||normalizeText(w.name)===normalizeText(q.wallet_name));
    if(!selected.length)return "Je ne trouve pas ce portefeuille dans vos comptes.";
    return "Solde calculé : "+selected.map(w=>w.name+" : "+money(Number(w.calculated_balance_minor??w.opening_balance_minor??0),w.currency)).join(" · ")+". Basé sur les mouvements actuellement chargés.";
  }
  if(q.kind==="expenses_by_category"){
    const grouped=new Map();rows.filter(t=>t.type==="expense"&&t.currency===currency).forEach(t=>{const k=t.category||"Non catégorisé";grouped.set(k,(grouped.get(k)||0)+amountFor(t));});
    if(!grouped.size)return "Aucune dépense correspondant à ces critères dans les transactions chargées.";
    return "Dépenses par catégorie ("+currency+") : "+[...grouped].sort((a,b)=>b[1]-a[1]).map(([k,v])=>k+" : "+money(v)).join(" ; ");
  }
  if(q.kind==="list_transactions"){
    const found=rows.slice(0,8);return found.length?"Voici les opérations correspondantes : "+found.map(t=>t.transaction_date+" — "+t.description+" — "+money(amountFor(t),t.currency)+" ("+txNature(t.type)+")").join(" | "):"Aucune opération correspondante dans les transactions chargées.";
  }
  let total=0;
  if(q.kind==="total_income")total=rows.filter(t=>t.type==="income"&&t.currency===currency).reduce((a,t)=>a+amountFor(t),0);
  else if(q.kind==="total_expense")total=rows.filter(t=>t.type==="expense"&&t.currency===currency).reduce((a,t)=>a+amountFor(t),0);
  else if(q.kind==="cash_in")total=rows.filter(t=>["income","loan_received","capital_contribution","opening_balance"].includes(t.type)&&t.currency===currency).reduce((a,t)=>a+amountFor(t),0);
  else if(q.kind==="cash_out")total=rows.filter(t=>["expense","loan_given","debt_repayment"].includes(t.type)&&t.currency===currency).reduce((a,t)=>a+amountFor(t),0);
  else if(q.kind==="net_result"){
    const inc=rows.filter(t=>t.type==="income"&&t.currency===currency).reduce((a,t)=>a+amountFor(t),0),exp=rows.filter(t=>t.type==="expense"&&t.currency===currency).reduce((a,t)=>a+amountFor(t),0);total=inc-exp;
  }else return "Je peux consulter les soldes, les revenus, les dépenses, les flux entrants/sortants, les résultats simplifiés, les dépenses par catégorie et les opérations. Précisez votre demande.";
  const label=({total_income:"Revenus",total_expense:"Dépenses",cash_in:"Entrées de trésorerie",cash_out:"Sorties de trésorerie",net_result:"Résultat simplifié"})[q.kind]||"Total";
  return label+" : "+money(total)+". Période : "+(q.start_date||"toutes dates chargées")+" à "+(q.end_date||"aujourd'hui")+". Calcul effectué à partir des transactions chargées, sans estimation IA.";
}
function appendChat(message,role){const el=document.createElement("div");el.className="chat-bubble "+role;el.textContent=message;$("chatLog").append(el);$("chatLog").scrollTop=$("chatLog").scrollHeight;}
async function refreshAll(){
  if(!client){setStatus("Configuration Supabase manquante","error");$("adminStatus").textContent="Ajoutez l'URL et la clé publique dans supabase.js.";$("authMessage").textContent="Configurez d'abord Supabase dans supabase.js.";$("authGate").hidden=false;return;}
  try{setStatus("Connexion Supabase…");const {data:auth,error:authErr}=await client.auth.getSession();if(authErr)throw authErr;if(!auth?.session){setStatus("Connexion requise","");$("adminStatus").textContent="Aucune session active.";$("authGate").hidden=false;return;}
    $("authGate").hidden=true;await loadWallets();await loadTransactions();setStatus("Connecté à Supabase","ok");$("adminStatus").textContent="Session active. Les droits effectifs dépendent des politiques RLS de la base.";
  }catch(e){setStatus("Erreur de connexion","error");toast(e.message,true);}
}
function bind(){
  $("navigation").addEventListener("click",e=>{const b=e.target.closest("[data-page]");if(b)showPage(b.dataset.page);});document.body.addEventListener("click",e=>{const b=e.target.closest("[data-goto]");if(b)showPage(b.dataset.goto);});$("quickAdd").addEventListener("click",()=>{resetForm();showPage("transactions");});
  $("refreshBtn").addEventListener("click",refreshAll);$("periodDays").addEventListener("change",renderDashboard);
  $("transactionForm").addEventListener("input",updateDraftState);$("transactionForm").addEventListener("change",updateDraftState);
  $("transactionForm").addEventListener("submit",handleTransactionSubmit);$("resetTransaction").addEventListener("click",resetForm);
  $("newTransactionBtn").addEventListener("click",()=>{resetForm();$("txAmount").focus();});
  $("transactionSearch").addEventListener("input",renderTransactions);$("walletForm").addEventListener("submit",createWallet);
  $("chatSend").addEventListener("click",sendToAssistant);$("chatInput").addEventListener("keydown",e=>{if(e.key==="Enter")sendToAssistant();});
  $("authForm").addEventListener("submit",async e=>{e.preventDefault();$("authSubmit").disabled=true;$("authMessage").textContent="Connexion en cours…";try{const {error}=await client.auth.signInWithPassword({email:$("authEmail").value.trim(),password:$("authPassword").value});if(error)throw error;$("authMessage").textContent="";await refreshAll();}catch(err){$("authMessage").textContent=err.message||"Connexion impossible.";}finally{$("authSubmit").disabled=false;}});
  $("signOutBtn").addEventListener("click",async()=>{if(!client)return;const {error}=await client.auth.signOut();if(error)toast(error.message,true);else{wallets=[];transactions=[];$("authGate").hidden=false;setStatus("Déconnecté","");}});
  $("runChecks").addEventListener("click",renderControl);$("runForecast").addEventListener("click",()=>{const a=Number($("forecastIncome").value),b=Number($("forecastExpense").value),m=Number($("forecastMonths").value);if(![a,b,m].every(Number.isFinite)||a<0||b<0||m<1||m>60){toast("Vérifiez les hypothèses.",true);return;}const net=(a-b)*m;$("forecastResult").textContent=`Variation cumulée estimée : ${new Intl.NumberFormat("fr-FR").format(net)} Ar sur ${m} mois. Hors solde initial, dette, impôts, décalages de paiement et saisonnalité.`;});
}
document.addEventListener("DOMContentLoaded",()=>{ $("txDate").value=today;$("walletDate").value=today;bind();refreshAll();});
window.FinanceCore=Object.freeze({toMinor,fromMinor,validDraft,txNature});
})();