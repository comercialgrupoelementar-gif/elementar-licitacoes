import {normalizeDocument, validDocument} from './documentos.mjs';
import {supabaseUrl, supabasePublishableKey} from './config.mjs';

const client = supabaseUrl && supabasePublishableKey
  ? window.supabase.createClient(supabaseUrl, supabasePublishableKey) : null;
const stages = ['Captado','Em análise','Aprovado','Reprovado'];
const modalities = ['Pregão eletrônico','Pregão presencial','Concorrência','Dispensa','Inexigibilidade','Aquisição simplificada · Caixa Escolar','Chamada pública','Obra · Caixa Escolar','Processo análogo','Pesquisa de preços','Concurso','Leilão','Diálogo competitivo'];
const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'});
const byId = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = text => { byId('notice').textContent = text; };
const tables = ['empresas','editais','itens','documentos'];
const db = Object.fromEntries(tables.map(table => [table,[]]));
const localKey = 'elementar-licitacoes-demo-v1';
const screens = {painel:'Painel geral',editais:'Captação',empresas:'Empresas e CNPJs',propostas:'Propostas',documentacao:'Documentação'};
let page = 'painel';
let activeEdital;
let group;
let session;
let groups = [];
let master = false;
let clients = [];
let team = [];
let detailMode = null;

function action(label, run, parent, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.onclick = () => Promise.resolve().then(run).catch(error => message(error.message));
  parent.append(button);
  return button;
}

function edit(title, fields, save) {
  const form = byId('form');
  byId('editor-title').textContent = title;
  form.replaceChildren();
  for (const [name,label,type,value,options] of fields) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const field = document.createElement(type === 'select' ? 'select' : 'input');
    field.name = name;
    if (type === 'select') {
      for (const option of options) {
        const [key,text] = Array.isArray(option) ? option : [option,option];
        field.add(new Option(text,key));
      }
    } else {
      field.type = type;
      if (type === 'number') { field.step = 'any'; field.min = '0'; }
    }
    field.value = value ?? '';
    field.required = !['sessao','validade','parecer','empresa_id'].includes(name);
    wrapper.append(field);
    form.append(wrapper);
  }
  const controls = document.createElement('div');
  controls.className = 'line';
  const submit = document.createElement('button');
  submit.textContent = title === 'Acessar sua conta' ? 'Entrar' : 'Salvar';
  submit.type = 'submit';
  submit.className = 'primary';
  controls.append(submit);
  action('Cancelar', () => byId('editor').close(), controls);
  form.append(controls);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      message('');
      await save(Object.fromEntries(new FormData(form)));
      byId('editor').close();
      render();
    } catch (error) {
      form.querySelector('[role=alert]')?.remove();
      const alert = document.createElement('p');
      alert.setAttribute('role','alert');
      alert.textContent = error.message;
      form.append(alert);
    } finally { submit.disabled = false; }
  };
  byId('editor').showModal();
}

async function load() {
  if (!client) {
    const data = JSON.parse(localStorage.getItem(localKey) || '{}');
    tables.forEach(table => { db[table] = data[table] ?? []; });
    return;
  }
  if (!group) { tables.forEach(table => { db[table] = []; }); return; }
  const responses = await Promise.all(tables.map(table => client.from(table).select().eq('grupo_id',group)));
  for (const response of responses) if (response.error) throw response.error;
  responses.forEach(({data},i) => { db[tables[i]] = data; });
}

async function save(table, values, id) {
  if (!client) {
    const records = db[table];
    const index = records.findIndex(record => record.id === id);
    if (index >= 0) records[index] = {...records[index],...values};
    else records.push({...values,id:crypto.randomUUID()});
    localStorage.setItem(localKey,JSON.stringify(db));
    return;
  }
  const query = client.from(table);
  const request = id ? query.update(values).eq('grupo_id',group).eq('id',id) : query.insert({...values,grupo_id:group});
  const {error} = await request.select('id').single();
  if (error) throw error;
  await load();
}

const groupRole = () => groups.find(item => item.id === group)?.role;
const canWrite = () => !client || ['admin','operador'].includes(groupRole());
const writeAction = (label,run,parent,primary) => { if (canWrite()) action(label,run,parent,primary); };

function company() {
  edit('Cadastrar empresa',[
    ['nome','Razão social','text'],['cnpj','CNPJ completo','text'],
    ['porte','Enquadramento informado','select','MEI',['MEI','MEI Caminhoneiro','ME','EPP','Demais']]
  ], values => {
    values.cnpj = normalizeDocument(values.cnpj);
    if (values.cnpj.length !== 14 || !validDocument(values.cnpj)) throw new Error('Informe um CNPJ válido, incluindo os dois dígitos verificadores.');
    if (db.empresas.some(row => row.cnpj === values.cnpj)) throw new Error('CNPJ já cadastrado neste grupo.');
    return save('empresas',values);
  });
}

function edital(row = {}) {
  edit(row.id ? 'Atualizar oportunidade' : 'Nova oportunidade',[
    ['numero','Identificação do processo','text',row.numero],['orgao','Órgão comprador','text',row.orgao],
    ['modalidade','Modalidade ou procedimento','select',row.modalidade ?? modalities[0],modalities],
    ['sessao','Data da sessão','date',row.sessao],
    ['empresa_id','CNPJ participante','select',row.empresa_id ?? '',[['','A definir'],...db.empresas.map(e => [e.id,e.nome+' · '+e.cnpj])]],
    ['status','Situação','select',row.status ?? stages[0],stages],
    ['parecer','Parecer da equipe','text',row.parecer]
  ], values => {
    if (values.status === 'Aprovado' && !values.empresa_id) throw new Error('Escolha o CNPJ participante antes de aprovar.');
    if (['Aprovado','Reprovado'].includes(values.status) && !values.parecer.trim()) throw new Error('Registre o motivo da decisão.');
    return save('editais',{...values,empresa_id:values.empresa_id || null,sessao:values.sessao || null},row.id);
  });
}

function item(row, previous = {}) {
  edit(previous.id ? 'Editar item da proposta' : 'Novo item da proposta',[
    ['codigo','Código do item','text',previous.codigo],['descricao','Descrição','text',previous.descricao],
    ['quantidade','Quantidade solicitada','number',previous.quantidade],
    ['embalagem','Unidades por embalagem','number',previous.embalagem ?? 1],
    ['custo_embalagem','Custo por embalagem (R$)','number',previous.custo_embalagem],
    ['margem','Margem bruta desejada (%)','number',previous.margem ?? 18]
  ], values => {
    for (const key of ['quantidade','embalagem','custo_embalagem','margem']) values[key] = Number(values[key]);
    if (values.quantidade <= 0 || values.embalagem <= 0 || values.margem >= 100) throw new Error('Quantidade e embalagem devem ser positivas. A margem deve ser inferior a 100%.');
    if (db.itens.some(x => x.edital_id === row.id && x.codigo === values.codigo && x.id !== previous.id)) throw new Error('Código já cadastrado nesta proposta.');
    return save('itens',{...values,edital_id:row.id},previous.id);
  });
}

function documentEditor(row, previous = {}) {
  edit(previous.id ? 'Conferir documento' : 'Adicionar requisito',[
    ['nome','Documento exigido','text',previous.nome],
    ['validade','Validade','date',previous.validade],
    ['conferido','Situação','select',previous.conferido ? 'sim' : 'nao',[['nao','Pendente'],['sim','Conferido']]]
  ], values => save('documentos',{...values,edital_id:row.id,validade:values.validade || null,conferido:values.conferido === 'sim'},previous.id));
}

const price = i => Number(i.preco_unitario ?? (Math.round((i.custo_embalagem / i.embalagem / (1 - i.margem / 100) + Number.EPSILON)*100)/100));
const total = rows => rows.reduce((sum,row) => sum + Math.round(price(row)*row.quantidade*100),0)/100;
const panel = (container, html) => {
  const section = document.createElement('section');
  section.className = 'panel';
  section.innerHTML = html;
  container.append(section);
  return section;
};

async function call(name, args) {
  const {data,error} = await client.rpc(name,args);
  if (error) throw new Error(error.message);
  return data;
}

async function openClients() {
  clients = await call('licitacoes_clientes');
  page = 'clientes'; activeEdital = null; render();
}

async function openTeam() {
  team = await call('licitacoes_equipe',{cliente:group});
  page = 'equipe'; activeEdital = null; render();
}

function renderClients(view) {
  const section = panel(view,'<h2>Mestre Gerenciador</h2><p>Cadastre empresas clientes e defina o administrador de cada espaço.</p>');
  action('Cadastrar empresa cliente', () => edit('Nova empresa cliente', [
    ['nome_cliente','Nome da empresa','text'],['email_admin','E-mail do administrador cadastrado','email']
  ], async values => {
    await call('licitacoes_criar_cliente',values);
    clients = await call('licitacoes_clientes');
  }), section,true);
  for (const customer of clients) panel(section,'<strong>'+escape(customer.nome)+'</strong><p>'+escape(customer.integrantes)+' integrante(s)</p>');
}

function renderTeam(view) {
  const section = panel(view,'<h2>Equipe da empresa</h2><p>Gerencie o acesso ao seu espaço de trabalho.</p>');
  action('Adicionar integrante', () => edit('Adicionar integrante',[
    ['email_membro','E-mail do usuário cadastrado','email'],
    ['papel_membro','Perfil','select','operador',[['operador','Operador'],['leitor','Leitor']]]
  ], async values => {
    await call('licitacoes_adicionar_membro',{...values,cliente:group});
    team = await call('licitacoes_equipe',{cliente:group});
  }),section,true);
  for (const member of team) panel(section,'<strong>'+escape(member.email)+'</strong><p>'+escape(member.papel)+'</p>');
}

function renderEditalIndex(view, docs) {
  const section = panel(view,docs ? '<h2>Documentação por edital</h2>' : '<h2>Propostas por edital</h2>');
  const rows = db.editais.filter(row => row.status === 'Aprovado' || db.itens.some(item => item.edital_id === row.id) || (docs && db.documentos.some(doc => doc.edital_id === row.id)));
  if (!rows.length) section.append(Object.assign(document.createElement('p'),{textContent:'Nenhum edital disponível. Aprove uma oportunidade na Captação.'}));
  for (const row of rows) {
    const card = panel(section,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p>');
    action(docs?'Abrir checklist':'Abrir proposta',()=>{detailMode=docs?'docs':'proposal';activeEdital=row.id;render();},card);
  }
}

function render() {
  const nav = byId('nav');
  const view = byId('view');
  const account = byId('account');
  for (const node of [nav,view,account]) node.replaceChildren();
  const platformView = master && page === 'clientes';
  const customer = groups.find(entry => entry.id === group);
  byId('page-title').textContent = platformView ? 'Administração da plataforma'
    : session || !client ? (page === 'equipe' ? 'Minha equipe' : screens[page] ?? 'Painel geral')
    : 'Acesso ao sistema';
  byId('connection').textContent = !client ? 'Modo demonstração · dados salvos somente neste navegador'
    : platformView ? 'E-Lementar · desenvolvedora da plataforma'
    : customer ? 'Área da empresa · ' + customer.nome
    : session ? 'Área da empresa' : 'Gestão de licitações e compras governamentais';
  if (client && !session) {
    const access = document.createElement('div');
    access.className = 'auth-layout';
    access.innerHTML = '<section class="auth-intro"><strong>E-Lementar Licitações</strong><h2>Da oportunidade à entrega.</h2><p>Organize editais, propostas e fornecimentos ao poder público.</p></section><section class="auth-access"><h2>Acesse sua empresa</h2><form id="login-form"><label>E-mail<input name="email" type="email" autocomplete="username" required></label><label>Senha<input name="password" type="password" autocomplete="current-password" required></label><button type="submit" class="primary">Entrar</button><p role="alert"></p></form></section>';
    view.append(access);
    const form = byId('login-form');
    form.onsubmit = async event => {
      event.preventDefault();
      const button = event.submitter;
      const errorBox = form.querySelector('[role=alert]');
      button.disabled = true;
      errorBox.textContent = '';
      try {
        const credentials = Object.fromEntries(new FormData(form));
        const {data,error} = await client.auth.signInWithPassword(credentials);
        if (error) throw error;
        session = data.session;
        form.reset();
        try { await loadGroups(); }
        catch (loadError) { message(loadError.message); }
        render();
      } catch (error) {
        errorBox.textContent = error.message === 'Invalid login credentials' ? 'E-mail ou senha incorretos.' : error.message;
      } finally { button.disabled = false; }
    };
    return;
  }
  if (client) {
    action('Sair', async () => {
      const {error} = await client.auth.signOut();
      if (error) throw error;
      session = null; group = null; master = false; groups = []; clients = []; team = []; page = 'painel'; activeEdital = null; await load(); render();
    },account);
    if (master) action('Mestre Gerenciador',openClients,nav).setAttribute('aria-current',String(page==='clientes'));
    if (!groups.length) {
      if (page === 'clientes' && master) renderClients(view);
      else panel(view,'<p>Seu usuário ainda está sem vínculo com uma empresa.</p>');
      return;
    }
    if (groupRole() === 'admin') action('Minha equipe',openTeam,nav).setAttribute('aria-current',String(page==='equipe'));
    const select = document.createElement('select');
    select.setAttribute('aria-label','Empresa cliente');
    groups.forEach(g => select.add(new Option(g.nome,g.id)));
    select.value = group;
    select.onchange = async () => {
      const previous = group;
      group = select.value; activeEdital = null; page = 'painel';
      try { await load(); render(); }
      catch(error) { group = previous; select.value = previous; message(error.message); }
    };
    nav.append(select);
  }
  for (const [key,label] of Object.entries(screens)) {
    action(label,() => {page=key;activeEdital=null;message('');render();},nav).setAttribute('aria-current',String(key===page));
  }
  if (page === 'clientes' && master) { renderClients(view); return; }
  if (page === 'equipe' && groupRole() === 'admin') { renderTeam(view); return; }
  if (activeEdital) { renderProposal(view,db.editais.find(x => x.id === activeEdital)); return; }
  if (page === 'propostas' || page === 'documentacao') { renderEditalIndex(view,page==='documentacao'); return; }
  if (page === 'painel') {
    const hero = document.createElement('section');
    hero.className = 'hero';
    hero.innerHTML = '<div><h2>Da captação à proposta</h2><p>Acompanhe oportunidades, prazos e valores da sua empresa.</p></div>';
    writeAction('Nova oportunidade', () => edital(), hero, true);
    view.append(hero);
    const grid = document.createElement('div');
    grid.className = 'grid dashboard-metrics';
    view.append(grid);
    for (const [label,value] of [['Oportunidades',db.editais.length],['Aprovadas',db.editais.filter(x=>x.status==='Aprovado').length],['CNPJs',db.empresas.length],['Valor em propostas',money.format(total(db.itens))]]) panel(grid,escape(label)+'<span class="stat">'+escape(value)+'</span>');
  } else if (page === 'empresas') {
    const section = panel(view,'<h2>Empresas e estabelecimentos</h2>');
    writeAction('Cadastrar empresa',company,section,true);
    for (const e of db.empresas) panel(section,'<strong>'+escape(e.nome)+'</strong><p>'+escape(e.cnpj)+' · '+escape(e.porte)+'</p>');
  } else {
    writeAction('Nova oportunidade',()=>edital(),view,true);
    const grid = document.createElement('div');
    grid.className = 'grid'; grid.style.marginTop='14px';
    view.append(grid);
    for (const stage of stages) {
      const lane = document.createElement('section');
      lane.className = 'lane';
      const rows = db.editais.filter(row => row.status===stage);
      lane.innerHTML = '<h3>'+escape(stage)+' · '+rows.length+'</h3>';
      grid.append(lane);
      for (const row of rows) {
        const card = panel(lane,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p><p class="muted">'+escape(row.modalidade)+'</p>');
        card.classList.add('card');
        writeAction('Analisar',()=>edital(row),card);
        if (row.status==='Aprovado' || db.itens.some(x=>x.edital_id===row.id)) action('Abrir proposta',()=>{detailMode=null;activeEdital=row.id;render();},card,true);
      }
    }
  }
}

function renderProposal(view,row) {
  const rows = db.itens.filter(x=>x.edital_id===row.id);
  const docs = db.documentos.filter(x=>x.edital_id===row.id);
  const section = panel(view,'<h2>Proposta · '+escape(row.numero)+'</h2><p>'+escape(row.orgao)+' · '+escape(db.empresas.find(e=>e.id===row.empresa_id)?.nome)+'</p><p>Total estimado <strong>'+money.format(total(rows))+'</strong></p>');
  if (row.status==='Aprovado') writeAction('Adicionar item',()=>item(row),section,true);
  const table = document.createElement('div');
  table.className = 'scroll';
  table.innerHTML = '<table><thead><tr><th>Item</th><th>Descrição</th><th>Qtde.</th><th>Custo unitário</th><th>Preço proposto</th><th>Total</th><th>Ações</th></tr></thead><tbody></tbody></table>';
  section.append(table);
  for (const entry of rows) {
    const tr = table.querySelector('tbody').insertRow();
    for (const value of [entry.codigo,entry.descricao,entry.quantidade,(entry.custo_embalagem/entry.embalagem).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:4}),money.format(price(entry)),money.format(total([entry]))]) tr.insertCell().textContent=value;
    const controls=tr.insertCell();
    if(row.status==='Aprovado') writeAction('Editar',()=>item(row,entry),controls);
  }
  if (detailMode === 'docs') section.remove();
  if (detailMode === 'proposal') return;
  const checklist=panel(view,'<h2>Checklist documental</h2>');
  writeAction('Adicionar requisito',()=>documentEditor(row),checklist,true);
  for(const doc of docs){
    const card=panel(checklist,'<strong>'+escape(doc.nome)+'</strong><p>'+escape(doc.conferido?'Conferido':'Pendente')+(doc.validade?' · validade '+escape(doc.validade):'')+'</p>');
    writeAction('Conferir',()=>documentEditor(row,doc),card);
  }
}

async function loadGroups(){
  const {data,error}=await client.from('membros').select('papel,grupos(id,nome)');
  if(error) throw error;
  groups=data.map(m=>({...m.grupos,role:m.papel}));
  const capability = await client.rpc('licitacoes_eh_mestre');
  if (capability.error && capability.error.code !== 'PGRST202') throw capability.error;
  master = capability.data === true;
  group=groups[0]?.id;
  await load();
}

try {
  if(client){
    const {data,error}=await client.auth.getSession();
    if(error) throw error;
    session=data.session;
    if(session) await loadGroups();
  } else await load();
  render();
} catch(error) { render(); message(error.message); }
