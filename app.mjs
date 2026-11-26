import {defaults as reportDefaults,collectReport,chartData,reportCompanyIdentity,renderExecutivePdf} from './relatorios.mjs?v=20261122-58';
import {contractAlerts, logisticsWorkspace} from './logistica.mjs?v=20261122-53';
import {normalizeDocument, validDocument} from './documentos.mjs';
import {makeZip} from './pacote.mjs';
import {supabaseUrl, supabasePublishableKey} from './config.mjs';

const client = supabaseUrl && supabasePublishableKey
  ? window.supabase.createClient(supabaseUrl, supabasePublishableKey) : null;
const stages = ['Captado','Em análise','Aprovado','Reprovado'];
const modalities = ['Pregão eletrônico','Pregão presencial','Concorrência','Dispensa','Inexigibilidade','Aquisição simplificada · Caixa Escolar','Chamada pública','Obra · Caixa Escolar','Processo análogo','Pesquisa de preços','Concurso','Leilão','Diálogo competitivo'];
const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',minimumFractionDigits:4,maximumFractionDigits:4});
const byId = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const message = text => { byId('notice').textContent = text; };
const tables = ['empresas','editais','itens','documentos'];
const registryTables = ['orgaos_compradores','catalogo','cotacoes','disputas','acompanhamentos'];
const allTables = [...tables,...registryTables];
const db = Object.fromEntries(allTables.map(table => [table,[]]));
const unavailableRegistries = new Set();
const localKey = 'elementar-licitacoes-demo-v1';
const screens = {
  painel:'Visão geral',orgaos:'Prefeituras / Clientes',catalogo:'Produtos / Serviços',
  cotacoes:'Cotações de Preços',orcamento:'Orçamento',editais:'Captação',
  propostas:'Propostas',documentacao:'Documentação',propostaPronta:'Proposta Pronta',
  disputa:'Disputa',acompanhamento:'Acompanhamento da Licitação',
  finalizados:'Processos Finalizados',logistica:'Logística',financeiro:'Financeiro',
  configuracoes:'Configurações',aplicativo:'Aplicativo',ajuda:'Central de Ajuda'
};
const pendingScreens = {
  orcamento:'Orçamentos para órgãos compradores antes da publicação do edital.',
  disputa:'Acompanhamento de lances e simulação de preços pela margem.',
  acompanhamento:'Negociação após a disputa, emissão de proposta readequada e acompanhamento até a assinatura.',
  finalizados:'Arquivo de ARP, ata da sessão, contratos e documentos do processo.',
  financeiro:'Análise de custos e solicitação de reajuste ou revisão de preços.',
  aplicativo:'Instalação e acesso ao aplicativo.'
};
let page = 'painel';
let activeEdital;
let group;
let session;
let groups = [];
let master = false;
let clients = [];
let team = [];
let detailMode = null;
let pendingActions = 0;
let workspaceRevision = 0;

function action(label, run, parent, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.onclick = async () => {
    pendingActions++;
    try { await run(); }
    catch (error) { message(error.message); }
    finally { pendingActions--; }
  };
  parent.append(button);
  return button;
}

function edit(title, fields, save, options = {}) {
  const {dialog = byId('editor'), decorate, onSaved = render} = options;
  const form = dialog.querySelector('form');
  dialog.querySelector('h2').textContent = title;
  form.replaceChildren();
  for (const [name,label,type,value,options] of fields) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const field = document.createElement(type === 'select' || type === 'textarea' ? type : 'input');
    field.name = name;
    if (type === 'select') {
      for (const option of options) {
        const [key,text] = Array.isArray(option) ? option : [option,option];
        field.add(new Option(text,key));
      }
    } else {
      if (type !== 'textarea') field.type = type;
      if (type === 'number') { field.step = 'any'; field.min = '0'; }
    }
    field.value = value ?? '';
    field.required = !['sessao','validade','parecer','empresa_id','email','marca','detalhes','observacao','edital_url','local_disputa','edital_pdf','nome_fantasia','logradouro','numero_endereco','complemento','bairro','cep','telefone'].includes(name);
    if (type === 'file' || ['marca_item','fornecedor','observacao_item'].includes(name)) field.required = false;
    if (type === 'file') field.accept = name === 'logo' ? 'image/png,image/jpeg' : '.pdf,application/pdf';
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
  action('Cancelar', () => dialog.close(), controls);
  form.append(controls);
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      message('');
      const result = await save(Object.fromEntries(new FormData(form)));
      dialog.close();
      onSaved(result);
    } catch (error) {
      form.querySelector('[role=alert]')?.remove();
      const alert = document.createElement('p');
      alert.setAttribute('role','alert');
      alert.textContent = error.message;
      form.append(alert);
    } finally { submit.disabled = false; }
  };
  decorate?.(form);
  dialog.showModal();
}

function workspaceQuery(table,company) {
  return client.from(table).select(table === 'editais'
    ? 'id,grupo_id,empresa_id,numero,numero_pregao,orgao,modalidade,sessao,status,parecer,edital_url,local_disputa,edital_pdf_nome,objeto,modo_disputa,etapa_proposta'
    : table==='cotacoes' ? 'id,grupo_id,empresa_id,titulo,fornecedor,email,observacao,etapa,itens,historico,revisao,criado_em,tipo,orgao_id,assinado_em' : '*').eq('grupo_id',company);
}

let screenAppearance=[];
async function load() {
  workspaceRevision++;
  screenAppearance=[];
  screenAccess={};
  currentCompanyProfile=null;
  if (!client) {
    const data = JSON.parse(localStorage.getItem(localKey) || '{}');
    allTables.forEach(table => { db[table] = data[table] ?? []; });
    return;
  }
  if (!group) {
    allTables.forEach(table => { db[table] = []; });
    unavailableRegistries.clear();
    return;
  }
  const {data:access,error:accessError}=await client.rpc('licitacoes_minhas_telas',{empresa:group});
  if(accessError) throw accessError;
  screenAccess=access??{};
  currentCompanyProfile=await call('licitacoes_meu_cargo',{empresa:group});
  const responses = await Promise.all(allTables.map(table => workspaceQuery(table,group)));
  const visual=await client.from('aparencia_telas').select('tela,ajustes').eq('grupo_id',group);
  if(visual.error && !['PGRST205','42P01'].includes(visual.error.code)) throw visual.error;
  screenAppearance=visual.data??[];
  const missing = new Set();
  responses.forEach(({error},i) => {
    if (!error) return;
    const table = allTables[i];
    if (!registryTables.includes(table) || !['PGRST205','42P01'].includes(error.code)) throw error;
    missing.add(table);
  });
  unavailableRegistries.clear();
  missing.forEach(table => unavailableRegistries.add(table));
  responses.forEach(({data},i) => { db[allTables[i]] = data ?? []; });
  workspaceRevision++;
}

async function save(table, values, id) {
  if (!client) {
    const records = db[table];
    const index = records.findIndex(record => record.id === id);
    const recordId = index >= 0 ? id : crypto.randomUUID();
    if (index >= 0) records[index] = {...records[index],...values};
    else records.push({...values,id:recordId,...(table==='catalogo' ? {codigo:'CAT-'+recordId} : {})});
    localStorage.setItem(localKey,JSON.stringify(db));
    return recordId;
  }
  const query = client.from(table);
  const request = id ? query.update(values).eq('grupo_id',group).eq('id',id) : query.insert({...values,grupo_id:group});
  const {data,error} = await request.select('id').single();
  if (error) throw error;
  await load();
  return data.id;
}

const groupRole = () => groups.find(item => item.id === group)?.role;
const isDemo = () => group==='4df12050-8638-4906-ae91-f0fb199f266d';
const canOpenCompanySettings = () => !client || groupRole()==='admin' || screenAccess.configuracoes==='operacao' ||
  (isDemo() && session?.user?.email==='demo@example.com');
function demoDelete(table,id,parent,onSaved=render) {
  if(!isDemo() || !canWrite()) return;
  action('Excluir',()=>edit('Excluir registro de demonstração',[],async()=>{
    const {data,error}=await client.from(table).delete().match({id,grupo_id:group}).select('id').maybeSingle();
    if(error?.code==='23503') throw new Error('Remova primeiro os registros vinculados.');
    if(error) throw error;
    if(!data) throw new Error('O registro não está disponível para exclusão.');
    await load();
  },{onSaved}),parent);
}

const canWrite = () => !client || (['admin','operador'].includes(groupRole()) && (!Object.hasOwn(screens,page) || screenAccess[page]==='operacao'));
const writeAction = (label,run,parent,primary) => { if (canWrite()) action(label,run,parent,primary); };

function companyFields(row = {}) {
  return [
    ['nome','Razão social','text',row.nome],['cnpj','CNPJ completo','text',row.cnpj],
    ['porte','Enquadramento informado','select',row.porte??'MEI',['MEI','MEI Caminhoneiro','ME','EPP','Demais']]
  ];
}

async function saveCompany(values,id) {
  values.nome = values.nome.trim();
  values.cnpj = normalizeDocument(values.cnpj);
  if (!values.nome) throw new Error('Informe a razão social.');
  if (values.cnpj.length !== 14 || !validDocument(values.cnpj)) throw new Error('Informe um CNPJ válido, incluindo os dois dígitos verificadores.');
  if (db.empresas.some(row => row.id!==id && row.cnpj === values.cnpj)) throw new Error('CNPJ já cadastrado neste grupo.');
  await save('empresas',values,id);
  return db.empresas.find(row=>row.cnpj===values.cnpj);
}

function company(record) {
  edit(record?'Editar empresa participante':'Cadastrar empresa participante',companyFields(record),values=>saveCompany(values,record?.id));
}

function agencyFields(row = {}) {
  return [
    ['cnpj','CNPJ','text',row.cnpj],
    ['nome','Razão social / Nome do órgão','text',row.nome],
    ['nome_fantasia','Nome fantasia','text',row.nome_fantasia],
    ['logradouro','Logradouro','text',row.logradouro],['numero_endereco','Número do endereço','text',row.numero],
    ['complemento','Complemento','text',row.complemento],['bairro','Bairro','text',row.bairro],
    ['cep','CEP','text',row.cep],['municipio','Município','text',row.municipio],
    ['uf','UF','select',row.uf ?? 'MG','AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ')],
    ['email','E-mail institucional','email',row.email],['telefone','Telefone','tel',row.telefone]
  ];
}

async function saveAgency(values,id) {
  const cnpj=normalizeDocument(values.cnpj);
  if(db.orgaos_compradores.some(row=>row.id!==id && normalizeDocument(row.cnpj)===cnpj)) throw new Error('Este CNPJ já está no cadastro de órgãos. Abra o registro existente para editar.');
  for (const key of Object.keys(values)) values[key] = values[key].trim();
  values.cnpj = normalizeDocument(values.cnpj);
  if (values.cnpj.length !== 14 || !validDocument(values.cnpj)) throw new Error('Informe um CNPJ válido.');
  if (!values.nome || !values.municipio) throw new Error('Informe o órgão e o município.');
  if (db.orgaos_compradores.some(entry=>entry.cnpj===values.cnpj && entry.id!==id)) throw new Error('Este CNPJ já está cadastrado.');
  const {numero_endereco,...data} = values;
  await save('orgaos_compradores',{...data,numero:numero_endereco},id);
  return db.orgaos_compradores.find(entry=>entry.cnpj===values.cnpj);
}

function agencyLookup(form) {
  const cnpj = form.elements.namedItem('cnpj');
  const controls = document.createElement('div');
  controls.className = 'line';
  cnpj.closest('label').after(controls);
  const status = document.createElement('span');
  status.setAttribute('role','status');
  const button = action('Consultar CNPJ',async()=>{
    const requested = normalizeDocument(cnpj.value);
    if (requested.length !== 14 || !validDocument(requested)) {
      status.textContent = 'Informe um CNPJ válido antes de consultar.';
      cnpj.focus();
      return;
    }
    button.disabled = true;
    status.textContent = 'Consultando dados públicos do CNPJ…';
    try {
      const response = await fetch('https://brasilapi.com.br/api/cnpj/v1/'+encodeURIComponent(requested),
        {signal:AbortSignal.timeout(12000)});
      if (response.status === 404) throw new Error('CNPJ não encontrado. Confira o número ou preencha manualmente.');
      if (!response.ok) throw new Error('Consulta indisponível. Tente novamente ou preencha manualmente.');
      const data = await response.json();
      if (!form.isConnected || !form.closest('dialog').open) return;
      if (normalizeDocument(cnpj.value) !== requested) {
        status.textContent = 'O CNPJ mudou. Consulte o novo número.';
        return;
      }
      if (normalizeDocument(data.cnpj) !== requested || !data.razao_social) {
        throw new Error('A consulta não retornou um cadastro válido para esse CNPJ.');
      }
      const fields = {
        nome:data.razao_social,nome_fantasia:data.nome_fantasia,
        logradouro:[data.descricao_tipo_de_logradouro,data.logradouro].filter(Boolean).join(' '),
        numero_endereco:data.numero,complemento:data.complemento,bairro:data.bairro,
        cep:data.cep,municipio:data.municipio,uf:data.uf,email:data.email,telefone:data.ddd_telefone_1
      };
      cnpj.value = requested;
      for (const [name,value] of Object.entries(fields)) form.elements.namedItem(name).value = value ?? '';
      status.textContent = 'Dados preenchidos pela BrasilAPI. Revise antes de salvar.';
    } catch (error) {
      status.textContent = error.name === 'TimeoutError' || error instanceof TypeError
        ? 'Consulta indisponível. Tente novamente ou preencha manualmente.' : error.message;
    } finally { button.disabled = false; }
  },controls);
  controls.append(status);
}

const normalizeSearch = value => value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/\p{Diacritic}/gu,'');

function registryPicker(form,{name,table,label,placeholder,title,fields,saveRecord,entryLabel,searchText,initial = '',legacy,apply}) {
  const select = form.elements.namedItem(name);
  select.value = initial;
  if (apply) select.onchange = ()=>apply(db[table].find(entry=>entry.id===select.value));

  const controls = document.createElement('div');
  controls.innerHTML = `<label>${label}<input type="search" placeholder="${placeholder}"></label>`;
  select.closest('label').before(controls);
  const search = controls.querySelector('input');
  function populate(selected) {
    const query = normalizeSearch(search.value.trim());
    const document = normalizeDocument(query);
    select.replaceChildren(new Option(placeholder,''));
    if (legacy) select.add(new Option(legacy+' · registro atual','atual'));
    for (const entry of db[table]) {
      if (entry.id !== selected && !normalizeSearch(searchText(entry)).includes(query)
          && !(document && entry.cnpj?.includes(document))) continue;
      select.add(new Option(entryLabel(entry),entry.id));
    }
    select.value = selected;
  }
  search.oninput = ()=>populate(select.value);
  populate(initial);
  if (unavailableRegistries.has(table)) {
    controls.append('Este cadastro aguarda a atualização do banco de dados.');
    return;
  }
  writeAction(title,()=>{
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label',title);
    dialog.innerHTML = '<h2></h2><form></form>';
    document.body.append(dialog);
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    edit(title,fields(search.value.trim()),saveRecord,{
      dialog,
      decorate:table === 'orgaos_compradores' ? agencyLookup : undefined,
      onSaved:entry=>{search.value='';populate(entry.id);apply?.(entry);select.focus();}
    });
  },controls);
}

function edital(row = {}) {
  edit(row.id ? 'Atualizar oportunidade' : 'Nova oportunidade',[
    ['numero','Número do processo','text',row.numero],
    ['numero_pregao','Número do pregão','text',row.numero_pregao],
    ['orgao','Órgão comprador','select','',[]],
    ['modalidade','Modalidade ou procedimento','select',row.modalidade ?? modalities[0],modalities],
    ['modo_disputa','Forma de disputa','select',row.modo_disputa??'item',[['item','Por item'],['lote','Por lote']]],
    ['objeto','Objeto da contratação','textarea',row.objeto],
    ['edital_url','Link da publicação do edital','url',row.edital_url],
    ['local_disputa','Local ou portal da disputa','text',row.local_disputa],
    ['edital_pdf','Anexar edital em PDF','file'],
    ['sessao','Data da sessão','date',row.sessao],
    ['empresa_id','CNPJ participante','select',row.empresa_id ?? '',[['','A definir'],...db.empresas.map(e => [e.id,e.nome+' · '+e.cnpj])]],
    ['status','Situação','select',row.status ?? stages[0],stages],
    ['parecer','Parecer da equipe','text',row.parecer]
  ], async values => {
    const agency = values.orgao === 'atual' ? row.orgao : db.orgaos_compradores.find(entry=>entry.id===values.orgao)?.nome;
    if (!agency) throw new Error('Selecione um órgão comprador do cadastro.');
    if (values.status === 'Aprovado' && !values.empresa_id) throw new Error('Escolha o CNPJ participante antes de aprovar.');
    if (['Aprovado','Reprovado'].includes(values.status) && !values.parecer.trim()) throw new Error('Registre o motivo da decisão.');
    const numero = values.numero.trim();
    if (!numero) throw new Error('Informe o número do processo.');
    const numeroPregao = values.modalidade.startsWith('Pregão ') ? values.numero_pregao.trim() : '';
    if (values.modalidade.startsWith('Pregão ') && !numeroPregao && (!row.id || row.modalidade !== values.modalidade || row.numero_pregao)) {
      throw new Error('Informe o número do pregão.');
    }
    const {edital_pdf:file,...data} = values;
    if (row.id && values.modo_disputa !== (row.modo_disputa??'item') && db.itens.some(item=>item.edital_id===row.id)) throw new Error('A forma de disputa só pode ser alterada antes de cadastrar os itens.');
    data.objeto = data.objeto.trim();
    if (!data.objeto && (!row.id || row.objeto)) throw new Error('Informe o objeto da contratação.');
    const editalUrl = data.edital_url.trim();
    if (editalUrl && !safeWebUrl(editalUrl)) throw new Error('Informe um link HTTP ou HTTPS para o edital.');
    if (file.size) {
      data.edital_pdf = await encodePdf(file);
      data.edital_pdf_nome = file.name;
    }
    return save('editais',{...data,numero,numero_pregao:numeroPregao || null,edital_url:editalUrl || null,
      local_disputa:data.local_disputa.trim() || null,orgao:agency,empresa_id:values.empresa_id || null,sessao:values.sessao || null},row.id);
  },{decorate:form=>{
    if (row.edital_pdf_nome) form.elements.namedItem('edital_pdf').closest('label').append('Arquivo atual: '+row.edital_pdf_nome);
    if (row.id && !row.objeto) form.elements.namedItem('objeto').required = false;
    const modalidade = form.elements.namedItem('modalidade');
    const pregao = form.elements.namedItem('numero_pregao');
    const syncPregao = () => {
      const visible = modalidade.value.startsWith('Pregão ');
      pregao.closest('label').hidden = !visible;
      pregao.closest('label').style.display = visible ? '' : 'none';
      pregao.required = visible && (!row.id || row.modalidade !== modalidade.value || Boolean(row.numero_pregao));
    };
    modalidade.addEventListener('change',syncPregao);
    syncPregao();
    const cnpjLabel = entry=>entry.nome+' · '+entry.cnpj;
    registryPicker(form,{name:'orgao',table:'orgaos_compradores',label:'Buscar órgão no cadastro',
      placeholder:'Nome, CNPJ ou município',title:'Cadastrar órgão comprador',fields:nome=>agencyFields({nome}),
      saveRecord:saveAgency,entryLabel:cnpjLabel,searchText:entry=>cnpjLabel(entry)+' '+entry.municipio,
      initial:row.orgao?'atual':'',legacy:row.orgao});
    registryPicker(form,{name:'empresa_id',table:'empresas',label:'Buscar CNPJ participante',
      placeholder:'Nome ou CNPJ',title:'Cadastrar CNPJ participante',fields:nome=>companyFields({nome}),
      saveRecord:saveCompany,entryLabel:cnpjLabel,searchText:cnpjLabel,initial:row.empresa_id??''});
  }});
}

function safeWebUrl(value) {
  try {
    const url = new URL(value);
    return ['http:','https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

async function encodePdf(file) {
  if (!file.size || file.size > 5*1024*1024 || await file.slice(0,5).text() !== '%PDF-') {
    throw new Error('Escolha um PDF válido de até 5 MB.');
  }
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>resolve(reader.result.split(',')[1]);
    reader.onerror = ()=>reject(reader.error);
    reader.readAsDataURL(file);
  });
}

async function downloadEdital(row) {
  let stored = row;
  if (client) {
    const {data,error} = await client.from('editais').select('edital_pdf,edital_pdf_nome').eq('grupo_id',group).eq('id',row.id).single();
    if (error) throw error;
    stored = data;
  }
  if (!stored.edital_pdf) throw new Error('O edital anexado está indisponível.');
  const bytes = Uint8Array.from(atob(stored.edital_pdf),character=>character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = stored.edital_pdf_nome || 'edital.pdf';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

function catalogFields(row = {}) {
  return [
    ['descricao','Descrição','text',row.descricao],
    ['tipo','Tipo','select',row.tipo ?? 'Produto',['Produto','Serviço']],['unidade','Unidade de medida','text',row.unidade],
    ['marca','Marca','text',row.marca],['detalhes','Detalhes','text',row.detalhes],
    ['observacao','Observações','text',row.observacao],['custo','Custo unitário (R$)','number',row.custo],
    ['margem','Margem sugerida (%)','number',row.margem ?? operationSettings().margem]
  ];
}

function catalogValues(values) {
  const record = Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.trim()]));
  if (!record.descricao || !record.unidade) throw new Error('Informe descrição e unidade.');
  if (!['Produto','Serviço'].includes(record.tipo)) throw new Error('Informe Produto ou Serviço no tipo.');
  for (const key of ['custo','margem']) {
    if (!/^\d+(?:[.,]\d+)?$/.test(record[key])) throw new Error('Informe custo e margem como números.');
    record[key] = Number(record[key].replace(',','.'));
  }
  if (!Number.isFinite(record.custo) || record.margem >= 100) throw new Error('Confira o custo e informe uma margem inferior a 100%.');
  return record;
}

async function saveCatalog(values,id) {
  const recordId = await save('catalogo',catalogValues(values),id);
  return db.catalogo.find(entry=>entry.id===recordId);
}

function renderRegistry(view, agencies) {
  const table = agencies ? 'orgaos_compradores' : 'catalogo';
  const singular = agencies ? 'órgão comprador' : 'produto ou serviço';
  const heading = agencies ? 'Órgãos compradores' : 'Catálogo de produtos e serviços';
  const section = panel(view,`<h2>${heading}</h2>`);
  if (unavailableRegistries.has(table)) {
    section.insertAdjacentHTML('beforeend','<p>Este cadastro aguarda a atualização do banco de dados.</p>');
    return;
  }
  function open(row = {}) {
    edit((row.id ? 'Editar ' : 'Cadastrar ')+singular,agencies ? agencyFields(row) : catalogFields(row),
      values=>agencies ? saveAgency(values,row.id) : saveCatalog(values,row.id),{decorate:agencies ? agencyLookup : undefined});
  }
  writeAction('Cadastrar '+singular,()=>open(),section,true);
  if (!agencies && canWrite()) {
    action('Importar catálogo Excel',importCatalog,section);
    section.insertAdjacentHTML('beforeend',' <a href="./modelo-cadastro-produtos-servicos.xlsx" download>Baixar modelo do catálogo (.xlsx)</a>');
  }
  section.insertAdjacentHTML('beforeend','<label>Buscar cadastro<input type="search"></label><div></div>');
  const search = section.querySelector('input');
  const list = section.lastElementChild;
  function draw() {
    const query = search.value.trim().toLocaleLowerCase('pt-BR');
    list.replaceChildren();
    const rows = db[table].filter(row => (agencies ? [row.nome,row.cnpj,row.municipio,row.uf]
      : [row.codigo,row.descricao,row.tipo,row.marca]).some(value => String(value ?? '').toLocaleLowerCase('pt-BR').includes(query)));
    if (!rows.length) list.textContent = 'Nenhum cadastro encontrado.';
    for (const row of rows) {
      const title = agencies ? row.nome : row.codigo+' · '+row.descricao;
      const subtitle = agencies ? row.cnpj+' · '+row.municipio+'/'+row.uf
        : row.tipo+' · '+row.unidade+' · Custo '+money.format(row.custo);
      const card = panel(list,'<strong>'+escape(title)+'</strong><p>'+escape(subtitle)+'</p>');
      if(agencies) {
        const records=db.editais.filter(entry=>entry.orgao===row.nome);
        if(records.length) action('Histórico de processos',()=>{
          const history=document.createElement('ul');
          history.className='registry-history';
          for(const entry of records) {const item=document.createElement('li');item.textContent=entry.numero+' · '+entry.status;history.append(item);}
          const existing=card.querySelector('.registry-history');
          if(existing) existing.remove(); else card.append(history);
        },card);
      } else {
        const costs=db.cotacoes.flatMap(quote=>(quote.itens??[]).filter(item=>item.catalogo_id===row.id&&item.aplicado_em).map(item=>({date:item.aplicado_em,source:quote.fornecedor}))).sort((x,y)=>y.date.localeCompare(x.date));
        if(costs.length) card.insertAdjacentHTML('beforeend','<p class="muted">Última cotação aplicada: '+escape(costs[0].source)+' · '+escape(supportDate(costs[0].date))+'</p>');
      }
      writeAction('Editar',()=>open(row),card);
      demoDelete(table,row.id,card);
    }
  }
  search.oninput = draw;
  draw();
}

function item(row, previous = {}) {
  edit(previous.id ? 'Editar item da proposta' : 'Novo item da proposta',[
    ['produto_catalogo','Vincular produto ou serviço do catálogo','select','',[]],
    ...(row.modo_disputa==='lote' ? [['lote','Número do lote','text',previous.lote]] : []),
    ['codigo','Número do item','text',previous.codigo],
    ['descricao','Descrição do edital','textarea',previous.descricao],
    ['origem_descricao','Descrição que sai na proposta','select',previous.usar_descricao_interna?'interna':'edital',[['edital','Descrição do edital'],['interna','Descrição interna da empresa']]],
    ['quantidade','Quantidade solicitada','number',previous.quantidade],
    ['unidade','Unidade de medida','text',previous.unidade],
    ['marca_item','Marca','text',previous.marca],
    ['embalagem','Unidades por embalagem','number',previous.embalagem ?? 1],
    ['custo_embalagem','Custo por embalagem (R$)','number',previous.custo_embalagem],
    ['margem','Margem bruta desejada (%)','number',previous.margem ?? operationSettings().margem],
    ['fornecedor','Fornecedor','text',previous.fornecedor],
    ['observacao_item','Observação interna','textarea',previous.observacao]
  ], values=>save('itens',proposalItem(row,values,previous),previous.id),{decorate:form=>{
    form.elements.namedItem('produto_catalogo').required = false;
    if (previous.id && !previous.unidade) form.elements.namedItem('unidade').required = false;
    const preview=document.createElement('p');
    preview.setAttribute('role','status');
    form.lastElementChild.before(preview);
    const updatePrice=()=>{
      const data=Object.fromEntries(new FormData(form));
      const margin=Number(data.margem);
      preview.textContent=data.custo_embalagem!=='' && Number(data.embalagem)>0 && margin>=0 && margin<100
        ? 'Preço unitário '+money.format(price(data))+' · Total '+money.format(total([data]))
        : 'Informe o custo, a embalagem e uma margem menor que 100%.';
    };
    form.addEventListener('input',updatePrice);
    updatePrice();
    const label = entry=>entry.codigo+' · '+entry.descricao;
    registryPicker(form,{name:'produto_catalogo',table:'catalogo',label:'Buscar produto ou serviço',
      placeholder:'Código ou descrição',title:'Cadastrar produto ou serviço',fields:descricao=>catalogFields({descricao}),
      saveRecord:saveCatalog,entryLabel:label,searchText:entry=>label(entry)+' '+(entry.marca??''),initial:previous.catalogo_id??'',
      apply:entry=>{
        if (!entry) return;
        const fields = form.elements;
        fields.namedItem('unidade').value ||= entry.unidade ?? '';
        fields.namedItem('marca_item').value ||= entry.marca ?? '';
        if (!fields.namedItem('custo_embalagem').value) {
          fields.namedItem('custo_embalagem').value = roundPrice((Number(fields.namedItem('embalagem').value)||1)*Number(entry.custo));
        }
        updatePrice();
      }});
  }});
}

function proposalItem(row, values, previous = {}) {
  const entry = db.catalogo.find(item=>item.id===values.produto_catalogo);
  const codigo = values.codigo.trim();
  const descricao = values.descricao.trim();
  const unidade = values.unidade.trim();
  if (!codigo || !descricao || (!unidade && !previous.id)) throw new Error('Informe número do item, descrição e unidade.');
  const numbers = Object.fromEntries(['quantidade','embalagem','custo_embalagem','margem'].map(key=>[key,Number(String(values[key]).replace(',','.'))]));
  if (!Object.keys(numbers).every(key=>String(values[key]).trim() && Number.isFinite(numbers[key])) || numbers.quantidade<=0 || numbers.embalagem<=0 || numbers.custo_embalagem<0 || numbers.margem<0 || numbers.margem>=100) {
    throw new Error('Confira quantidade, embalagem, custo e margem. A margem deve ser menor que 100%.');
  }
  const lote = (values.lote??'').trim();
  if (row.modo_disputa==='lote' ? !lote : lote) throw new Error(row.modo_disputa==='lote'?'Informe o número do lote.':'Deixe o lote vazio na disputa por item.');
  if (db.itens.some(item=>item.edital_id===row.id && (item.lote??'')===lote && item.codigo===codigo && item.id!==previous.id)) throw new Error('Número de item já cadastrado nesta proposta.');
  const usar_descricao_interna = values.origem_descricao === 'interna';
  if (usar_descricao_interna && !entry?.descricao) throw new Error('Vincule um produto do catálogo para usar a descrição interna.');
  return {...numbers,lote,codigo,descricao,unidade,edital_id:row.id,catalogo_id:entry?.id??null,
    descricao_interna:entry?.id===previous.catalogo_id ? previous.descricao_interna??entry?.descricao??null : entry?.descricao??null,
    usar_descricao_interna,marca:values.marca_item.trim(),fornecedor:values.fornecedor.trim(),observacao:values.observacao_item.trim()};
}

function documentEditor(row, previous = {}) {
  edit(previous.id ? 'Conferir documento' : 'Adicionar requisito',[
    ['nome','Documento exigido','text',previous.nome],
    ['validade','Validade','date',previous.validade],
    ['conferido','Situação','select',previous.conferido ? 'sim' : 'nao',[['nao','Pendente'],['sim','Conferido']]]
  ], values => save('documentos',{...values,edital_id:row.id,validade:values.validade || null,conferido:values.conferido === 'sim'},previous.id));
}

const decimal = new Intl.NumberFormat('pt-BR',{minimumFractionDigits:4,maximumFractionDigits:4});
const precision = 10000;
const roundPrice = value => Math.round((value + Number.EPSILON)*precision)/precision;
const price = item => item.custo_embalagem==null ? Number(item.preco_unitario) :
  roundPrice(item.custo_embalagem / item.embalagem / (1 - item.margem / 100));
const total = rows => rows.reduce((sum,row) => sum + Math.round(price(row)*row.quantidade*precision),0)/precision;
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

let masterNavigationRequest=0;
async function openClients(key='clientes') {
  const request=++masterNavigationRequest;
  if (['clientes','masterAssinaturas','masterFinanceiro'].includes(key)) await loadCommercialRecords();
  if (['clientes','masterEmpresas','masterAcessos','masterAparencia','masterAssinaturas','masterFinanceiro','masterSuporte'].includes(key)) clients = await call('licitacoes_clientes');
  if(key==='clientes') {
    const {count,error}=await client.from('chamados_clientes').select('id',{count:'exact',head:true}).neq('situacao','Resolvido');
    if(error) throw error;
    openTicketCount=count ?? 0;
  }
  if(request!==masterNavigationRequest || !master) return;
  page = key; activeEdital = null; render();
}

const accessLevels=[['bloqueado','Sem acesso'],['consulta','Somente consulta'],['operacao','Operar']];
let screenAccess={};
let currentCompanyProfile=null;
const profileLabel=(role,cargo)=>cargo||({admin:'Administrador',operador:'Operador',leitor:'Leitor'}[role]??'Usuário');
const screenAllowed=key=>!client || !Object.hasOwn(screens,key) || screenAccess[key]!=='bloqueado';


const accessPresets = {
  'Operador': {read:['painel','catalogo','orgaos','ajuda'], write:['editais','documentacao','propostas']},
  'Representante': {read:['painel','orgaos','catalogo','propostas','propostaPronta','ajuda'], write:['disputa','acompanhamento']},
  'Administrador 01': {read:['financeiro','configuracoes','aplicativo','finalizados'], write:['orgaos','catalogo','cotacoes','orcamento','editais','propostas','documentacao','propostaPronta','disputa','acompanhamento','logistica','ajuda']},
  'Administrador 02': {read:['aplicativo'], write:Object.keys(screens).filter(key=>key!=='aplicativo')},
  'Auxiliar de Licitação': {read:['painel','catalogo','orgaos','propostas','ajuda'], write:['editais','documentacao']},
  'Analista de Licitação': {read:['painel','catalogo','orgaos','propostaPronta','ajuda'], write:['editais','documentacao','propostas','disputa','acompanhamento']},
  'Gerente': {read:['configuracoes','aplicativo','finalizados'], write:Object.keys(screens).filter(key=>!['configuracoes','aplicativo','finalizados'].includes(key))},
  'Coordenador': {read:['painel','catalogo','orgaos','financeiro','finalizados','ajuda'], write:['editais','documentacao','propostas','propostaPronta','disputa','acompanhamento','logistica']},
  'Dono': {read:[], write:Object.keys(screens)},
  'Sócio': {read:Object.keys(screens), write:[]}
};

function presetScreenRules(preset) {
  return Object.fromEntries([
    ...preset.read.map(key=>[key,'consulta']),
    ...preset.write.map(key=>[key,'operacao'])
  ]);
}

function mountCargoManagement(parent,empresa,mestre=false) {
  const section=panel(parent,'<h2>Perfis e permissões</h2><p>Os perfis definem as regras padrão. O limite da empresa é o máximo permitido. As permissões individuais ajustam a regra de cada usuário dentro desse limite.</p>');
  if(!mestre) action('Gerenciar cargos e permissões',()=>refresh(),section,true);
  const content=document.createElement('div');
  section.append(content);
  if(mestre) {
    content.textContent='Carregando perfis…';
    refresh().catch(error=>{ if(content.isConnected) content.textContent='Não foi possível carregar os perfis. '+error.message; });
  }
  async function refresh() {
    const state=await call('licitacoes_painel_cargos',{empresa});
    if(!content.isConnected) return;
    content.replaceChildren();
    const levels=(rules,defaultLevel)=>Object.entries(screens).map(([key,label])=>[key,label,'select',rules[key]??defaultLevel,accessLevels]);
    const saveRules=(heading,fields,save)=>edit(heading,fields,save,{onSaved:()=>refresh().catch(error=>message(error.message))});
    function editCargo(cargo={}) {
      saveRules('Permissões do cargo',[
        ['nome_cargo','Nome do cargo','text',cargo.nome],...levels(cargo.regras??{},'bloqueado')
      ],({nome_cargo,...regras_cargo})=>call('licitacoes_gravar_cargo',{empresa,nome_cargo,regras_cargo,cargo:cargo.id??null}));
    }
    if(mestre) action('Definir limites da empresa',()=>saveRules('Limites máximos por tela',
      levels(state.limites,'operacao'),regras_telas=>call('licitacoes_gravar_limites',{empresa,regras_telas})),content,true);
    action('Cadastrar novo perfil',()=>editCargo(),content,true);
    if(mestre) renderProfileOverview(content,state,editCargo);
    const template=mestre?null:panel(content,'<h3>Modelos de cargo</h3>');
    const availablePresets=Object.keys(accessPresets).filter(name=>!state.cargos.some(cargo=>cargo.nome===name));
    if(!mestre && availablePresets.length) action('Adicionar perfil padrão',()=>edit('Adicionar perfil padrão',[
      ['nome','Perfil','select',availablePresets[0],availablePresets]
    ],({nome})=>call('licitacoes_gravar_cargo',{empresa,nome_cargo:nome,regras_cargo:presetScreenRules(accessPresets[nome])}),
    {onSaved:()=>refresh().catch(error=>message(error.message))}),template);
    if(!mestre) {
    const cargos=panel(content,'<h3>Cargos cadastrados</h3>');
    if(!state.cargos.length) cargos.append('Nenhum cargo personalizado cadastrado.');
    for(const cargo of state.cargos) {
      const card=panel(cargos,'<strong>'+escape(cargo.nome)+'</strong> ');
      action('Editar permissões',()=>editCargo(cargo),card);
    }
    }
    const members=panel(content,'<h3>Perfis atribuídos e regras individuais</h3>');
    for(const member of state.integrantes) {
      const current=state.cargos.find(cargo=>cargo.id===member.cargo_id);
      const card=panel(members,'<strong>'+escape(member.email)+'</strong><p>'+escape(profileLabel(member.papel,current?.nome))+'</p>');
      if(mestre) {
        action('Telas e permissões do usuário',()=>saveRules('Permissões de '+member.email,[
          ...Object.entries(screens).map(([key,label])=>[key,label,'select',member.regras_individuais?.[key]??'perfil',[
            ['perfil','Seguir o perfil'],...accessLevels
          ]])
        ],values=>call('licitacoes_gravar_regras_individuais',{empresa,integrante:member.id,
          regras:Object.fromEntries(Object.entries(values).filter(([,value])=>value!=='perfil'))})),card);
        if(member.papel!=='admin') action('Ações de cadastro',()=>editRegistryPermissions(empresa,{usuario_id:member.id,email:member.email},refresh),card);
      }
      if(member.papel==='admin') continue;
      action('Alterar cargo',()=>saveRules('Cargo de '+member.email,[
        ['cargo','Cargo na empresa','select',member.cargo_id??'base',[['base','Usar perfil básico do usuário'],...state.cargos.map(cargo=>[cargo.id,cargo.nome]),...availablePresets.map(nome=>['modelo:'+nome,nome])]]
      ],async ({cargo})=>{
        if(cargo.startsWith('modelo:')) {
          const nome=cargo.slice(7);
          await call('licitacoes_gravar_cargo',{empresa,nome_cargo:nome,regras_cargo:presetScreenRules(accessPresets[nome])});
          const updated=await call('licitacoes_painel_cargos',{empresa});
          cargo=updated.cargos.find(profile=>profile.nome===nome).id;
        }
        await call('licitacoes_atribuir_cargo',{empresa,integrante:member.id,cargo:cargo==='base'?null:cargo});
      }),card);
    }
  }
}

function renderProfileOverview(parent,state,editCargo) {
  const section=panel(parent,'<h3>Telas por perfil</h3><p>Os modelos aparecem para consulta. Ao salvar um modelo, ele vira um perfil editável desta empresa.</p>');
  const profiles=[
    ...Object.entries(accessPresets).map(([nome,preset])=>state.cargos.find(cargo=>cargo.nome===nome)??{nome,regras:presetScreenRules(preset)}),
    ...state.cargos.filter(cargo=>!Object.hasOwn(accessPresets,cargo.nome))
  ];
  const label=document.createElement('label');
  const select=document.createElement('select');
  for(const [index,profile] of profiles.entries()) select.add(new Option(profile.nome,String(index)));
  label.append('Perfil',select);
  section.append(label);
  const result=document.createElement('div');
  result.className='table-wrap';
  section.append(result);
  const levels=Object.fromEntries(accessLevels);
  const rank=Object.keys(levels);
  function show() {
    const profile=profiles[Number(select.value)];
    const rows=Object.entries(screens).map(([key,name])=>{
      const rule=profile.regras[key]??'bloqueado';
      const limit=state.limites[key]??'operacao';
      const effective=rank[Math.min(rank.indexOf(rule),rank.indexOf(limit))];
      return '<tr><th scope="row">'+escape(name)+'</th><td>'+escape(levels[rule])+'</td><td>'+escape(levels[effective])+'</td></tr>';
    }).join('');
    result.innerHTML='<p>'+ (profile.id?'Perfil cadastrado':'Modelo padrão')+'</p><table><thead><tr><th scope="col">Tela</th><th scope="col">Regra do perfil</th><th scope="col">Após limite da empresa</th></tr></thead><tbody>'+rows+'</tbody></table>';
  }
  select.onchange=show;
  action('Editar permissões do perfil',()=>editCargo(profiles[Number(select.value)]),section,true);
  show();
}

let teamNames={};
async function openTeam() {
  team = groupRole()==='admin' ? await call('licitacoes_equipe',{cliente:group}) : [];
  teamNames = groupRole()==='admin' ? await call('licitacoes_nomes_equipe',{empresa:group}) : {};
  page = 'equipe'; activeEdital = null; render();
}

function renderVisualPreview(parent,customerId,modules=Object.keys(screens)) {
  const section=panel(parent,'<h3>Aparência por tela</h3>');
  const preview=panel(section,'<h2></h2><p>Texto, títulos e ações da tela</p>');
  const controls=document.createElement('div');
  controls.className='line';
  section.insertBefore(controls,preview);
  function field(label,element) {
    const wrapper=document.createElement('label');
    wrapper.append(label,element);
    controls.append(wrapper);
    return element;
  }
  function select(label, options) {
    const element=field(label,document.createElement('select'));
    for(const [value,name] of options) element.add(new Option(name,value));
    return element;
  }
  function slider(label,min,max,value) {
    const element=field(label,document.createElement('input'));
    element.type='range';
    Object.assign(element,{min,max,value});
    return element;
  }
  const screen=select('Tela',modules.map(key=>[key,screens[key]]));
  const font=select('Fonte',[['inherit','Padrão'],['system-ui','Sistema'],['Georgia, serif','Georgia'],['monospace','Monoespaçada']]);
  const align=select('Alinhamento',[['left','Esquerda'],['center','Centro'],['right','Direita']]);
  const size=slider('Tamanho do texto',12,22,14);
  const title=slider('Tamanho do título',16,40,24);
  const padding=slider('Espaçamento interno',8,40,16);
  const width=slider('Largura do painel (%)',35,100,100);
  const example=action('Exemplo de botão',()=>{},preview);
  example.disabled=true;
  const draw=()=>{
    preview.querySelector('h2').textContent=screens[screen.value];
    Object.assign(preview.style,{fontFamily:font.value,textAlign:align.value,fontSize:size.value+'px',
      padding:padding.value+'px',width:width.value+'%',overflowWrap:'anywhere'});
    Object.assign(preview.querySelector('h2').style,{fontFamily:'inherit',fontSize:title.value+'px'});
  };
  const fields={font,align,size,title,padding,width};
  async function loadAppearance() {
    const {data,error}=await client.from('aparencia_telas').select('ajustes').match({grupo_id:customerId,tela:screen.value}).maybeSingle();
    if(error) throw error;
    const defaults={font:'inherit',align:'left',size:12,title:24,padding:16,width:100};
    for(const [key,input] of Object.entries(fields)) input.value=data?.ajustes[key]??defaults[key];
    draw();
  }
  screen.addEventListener('change',()=>loadAppearance().catch(error=>message(error.message)));
  controls.addEventListener('input',draw);
  action('Salvar aparência',async()=>{
    const ajustes=Object.fromEntries(Object.entries(fields).map(([key,input])=>[key,input.value]));
    const {error}=await client.from('aparencia_telas').upsert({grupo_id:customerId,tela:screen.value,ajustes});
    if(error) throw error;
    if(customerId===group) await load();
    message('Aparência salva.');
  },section);
  draw();
  loadAppearance().catch(error=>message(error.message));
}

let commercialRecords = [];
const commercialSections = {
  assinatura: ['Assinaturas', 'Configurar assinatura', ['Ativa','Em avaliação','Suspensa','Cancelada']],
  cobranca: ['Financeiro comercial', 'Registrar cobrança', ['Pendente','Recebida','Cancelada']],
  suporte: ['Suporte interno', 'Registrar chamado', ['Aberto','Em atendimento','Resolvido']]
};

let openTicketCount = 0;
async function loadCommercialRecords() {
  const {data,error} = await client.from('gestao_comercial').select('*').order('prazo');
  if (error) throw new Error(error.message);
  commercialRecords = data;
}

function editCommercialRecord(type, record = {}) {
  const [,label,states] = commercialSections[type];
  const companies = clients.filter(company => type !== 'assinatura' || company.id === record.grupo_id ||
    !commercialRecords.some(entry => entry.tipo === type && entry.grupo_id === company.id));
  if (!companies.length) throw new Error('Nenhuma empresa disponível para este registro.');
  const fields = [
    ['grupo_id','Empresa','select',record.grupo_id,companies.map(company => [company.id,company.nome])],
    ['titulo',type === 'assinatura' ? 'Plano' : 'Título','text',record.titulo],
    ['situacao','Situação','select',record.situacao,states],
    ['prazo',type === 'suporte' ? 'Prazo de atendimento' : 'Vencimento','date',record.prazo],
    ['observacao','Observação','textarea',record.observacao]
  ];
  if (type !== 'suporte') fields.splice(3,0,['valor',type === 'assinatura' ? 'Mensalidade (R$)' : 'Valor (R$)','number',record.valor ?? 0]);
  edit(label,fields,async values => {
    const payload = {...values,tipo:type,valor:Number(values.valor ?? 0)};
    const table = client.from('gestao_comercial');
    const result = record.id ? await table.update(payload).eq('id',record.id).select('id').single() : await table.insert(payload);
    if (result.error) throw new Error(result.error.message);
    await loadCommercialRecords();
  });
}


function renderPlatformOverview(view,today,money) {
  const deadlines=panel(view,'<h2>Prazos e pendências</h2><div></div>').lastElementChild;
  const hero=document.createElement('section');
  hero.className='overview-banner';
  hero.innerHTML='<div><span class="eyebrow">ADMINISTRAÇÃO DA PLATAFORMA</span><h2>Clientes, assinaturas e suporte.</h2><p>Acompanhe a carteira e resolva as pendências da plataforma.</p><div class="hero-buttons"></div></div><div class="banner-side"></div>';
  view.append(hero);
  const shortcuts=hero.querySelector('.hero-buttons');
  action('Ver empresas clientes',()=>openMasterPage('masterEmpresas'),shortcuts).className='accent';
  action('Ver assinaturas',()=>openMasterPage('masterAssinaturas'),shortcuts).className='outline-light';
  action('Ver chamados',()=>openMasterPage('masterSuporte'),shortcuts).className='outline-light';
  const bannerStats=hero.querySelector('.banner-side');
  const header=panel(view,'<h2>Análise da plataforma</h2><div class="line"></div>');

  const controls=header.querySelector('.line');
  function filter(label,options) {
    const wrapper=document.createElement('label');
    const select=document.createElement('select');
    wrapper.append(label,select);
    for(const [value,text] of options) select.add(new Option(text,value));
    select.onchange=draw;
    controls.append(wrapper);
    return select;
  }
  const company=filter('Empresa',[['','Todas as empresas'],...clients.map(row=>[row.id,row.nome])]);
  const years=[...new Set([today.slice(0,4),...commercialRecords.map(row=>row.prazo?.slice(0,4)).filter(Boolean)])].sort().reverse();
  const year=filter('Ano em vigor',[...years.map(value=>[value,value]),['','Todos os anos']]);
  const grouping=filter('Agrupar por',[['status','Situação'],['company','Empresa'],['month','Mês do vencimento']]);
  const indicator=filter('Indicador do gráfico',[['value','Valor das cobranças'],['count','Número de cobranças']]);

  const results=document.createElement('div');
  view.append(results);
  function draw() {
    results.replaceChildren();
    const filteredClients=clients.filter(row=>!company.value||row.id===company.value);
    const scoped=commercialRecords.filter(row=>!company.value||row.grupo_id===company.value);
    const subscriptions=scoped.filter(row=>row.tipo==='assinatura');
    const charges=scoped.filter(row=>row.tipo==='cobranca'&&(!year.value||row.prazo?.startsWith(year.value)));
    const pending=charges.filter(row=>row.situacao==='Pendente');
    const overdue=pending.filter(row=>row.prazo&&row.prazo<today);
    const received=charges.filter(row=>row.situacao==='Recebida');
    const sum=rows=>rows.reduce((value,row)=>value+Number(row.valor||0),0);
    const active=subscriptions.filter(row=>row.situacao==='Ativa');
    bannerStats.innerHTML=[['Empresas clientes',filteredClients.length],['Assinaturas ativas',active.length],
      ['Cobranças vencidas',overdue.length],['A receber',money.format(sum(pending))]]
      .map(([label,value])=>'<div><span>'+escape(label)+'</span><strong>'+escape(value)+'</strong></div>').join('');
    const soon=new Date(today+'T00:00:00Z');
    soon.setUTCDate(soon.getUTCDate()+7);
    const cutoff=soon.toISOString().slice(0,10);
    const dueSoon=pending.filter(row=>row.prazo&&row.prazo>=today&&row.prazo<=cutoff);
    const renewal=active.filter(row=>row.prazo&&row.prazo>=today&&row.prazo<=cutoff);
    const pendingRows=[...overdue.map(row=>[row,'Cobrança vencida']),...dueSoon.map(row=>[row,'Cobrança a vencer']),
      ...renewal.map(row=>[row,'Assinatura a vencer'])].sort(([a],[b])=>a.prazo.localeCompare(b.prazo));
    deadlines.replaceChildren();
    if(!pendingRows.length) deadlines.textContent='Nenhuma cobrança vencida ou vencimento nos próximos sete dias para estes filtros.';
    else {
      const deadlineTable=quoteTable(deadlines,['Prazo','Empresa','Pendência','Registro']);
      for(const [entry,label] of pendingRows.slice(0,10)) {
        const row=deadlineTable.insertRow();
        for(const value of [entry.prazo.split('-').reverse().join('/'),clients.find(c=>c.id===entry.grupo_id)?.nome??'Empresa',label,entry.titulo]) row.insertCell().textContent=value;
      }
      if(pendingRows.length>10) deadlines.append('Exibindo as 10 primeiras de '+pendingRows.length+' pendências.');
    }

    const grid=panel(results,'<h3>Indicadores da plataforma</h3>');
    const cards=document.createElement('div');cards.className='grid overview-metrics';grid.append(cards);
    function metric(title,value,route) {
      const card=panel(cards,'<strong>'+escape(title)+'</strong><p>'+escape(value)+'</p>');
      action('Ver '+title.toLowerCase(),()=>openMasterPage(route),card);
      return card.querySelector('p');
    }
    metric('Empresas clientes',filteredClients.length,'masterEmpresas');
    metric('Assinaturas ativas',subscriptions.filter(row=>row.situacao==='Ativa').length,'masterAssinaturas');
    metric('Cobranças vencidas',overdue.length,'masterFinanceiro');
    metric('A receber',money.format(sum(pending)),'masterFinanceiro');
    metric('Recebido',money.format(sum(received)),'masterFinanceiro');
    const ticketValue=metric('Chamados pendentes',company.value?'Carregando…':openTicketCount,'masterSuporte');
    if(company.value) client.from('chamados_clientes').select('id',{count:'exact',head:true})
      .eq('grupo_id',company.value).neq('situacao','Resolvido').then(({count,error})=>{
        if(ticketValue.isConnected) ticketValue.textContent=error?'Indisponível':count??0;
      });
    function chart(title,rows,format) {
      const section=panel(results,'<h3>'+escape(title)+'</h3>');
      const table=quoteTable(section,['Situação','Indicador','Total']);
      const max=Math.max(1,...rows.map(([,value])=>value));
      for(const [label,value] of rows) {
        const row=table.insertRow();
        row.insertCell().textContent=label;
        const meter=document.createElement('meter');
        meter.max=max;meter.value=value;meter.style.width='100%';meter.setAttribute('aria-label',label);
        row.insertCell().append(meter);row.insertCell().textContent=format(value);
      }
    }
    chart('Assinaturas por situação',commercialSections.assinatura[2].map(status=>[status,subscriptions.filter(row=>row.situacao===status).length]),String);
    const dimensions=new Map();
    for(const row of charges) {
      const label=grouping.value==='company'?(clients.find(c=>c.id===row.grupo_id)?.nome??'Empresa'):
        grouping.value==='month'?(row.prazo?.slice(0,7).split('-').reverse().join('/')??'Sem vencimento'):
        row.situacao==='Pendente'?(row.prazo&&row.prazo<today?'Vencida':'Pendente'):row.situacao;
      dimensions.set(label,(dimensions.get(label)??0)+(indicator.value==='count'?1:Number(row.valor||0)));
    }
    chart('Distribuição das cobranças',[...dimensions].sort((a,b)=>b[1]-a[1]),
      indicator.value==='count'?String:value=>money.format(value));

  }
  draw();
}

function renderCommercialDashboard(view,selectedType) {
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const money = new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL',minimumFractionDigits:4});
  if (!selectedType) { renderPlatformOverview(view,today,money); return; }
  for (const [type,[title,label]] of Object.entries(commercialSections)) {
    if (type!==selectedType) continue;
    const section = panel(view,'<h2>'+title+'</h2>');
    action(label,()=>editCommercialRecord(type),section,true);
    const rows = commercialRecords.filter(entry => entry.tipo === type);
    if (!rows.length) section.append(Object.assign(document.createElement('p'),{textContent:'Nenhum registro cadastrado.'}));
    for (const entry of rows) {
      const company = clients.find(customer => customer.id === entry.grupo_id);
      const value = type === 'suporte' ? '' : ' · '+money.format(entry.valor);
      const card = panel(section,'<strong>'+escape(entry.titulo)+'</strong><p>'+escape(company?.nome ?? 'Empresa')+
        ' · '+escape(entry.situacao)+' · '+escape(entry.prazo.split('-').reverse().join('/'))+value+'</p><p>'+escape(entry.observacao)+'</p>');
      action('Editar',()=>editCommercialRecord(type,entry),card);
    }
  }
}

const masterPages = {
  clientes:'Visão da plataforma',
  masterEmpresas:'Empresas clientes',
  masterAcessos:'Usuários e permissões',
  masterAssinaturas:'Assinaturas',
  masterFinanceiro:'Financeiro comercial',
  masterComercial:'Solicitações comerciais',
  masterSuporte:'Chamados de clientes',
  masterAparencia:'Aparência por tela',
  masterAuditoria:'Auditoria administrativa',
  masterRelatorios:'Configurações de relatórios',
  masterVersoes:'Versão do sistema'
};

async function openMasterPage(key) {
  await openClients(key);
}

function renderMasterRecords(view, table, columns, limit, prepare) {
  const section=panel(view,'<p role="status">Carregando registros…</p>');
  client.from(table).select(columns).order(table==='interesses_comerciais'?'criado_em':'ocorrido_em',{ascending:false})
    .limit(limit).then(({data,error})=>{
      if (!section.isConnected) return;
      section.replaceChildren();
      if (error) { section.textContent=error.message; return; }
      if (!data.length) section.textContent='Nenhum registro encontrado.';
      for (const row of data) prepare(section,row);
    }).catch(error=>{if(section.isConnected) section.textContent=error.message;});
}

const supportFileTypes = ['application/pdf','image/png','image/jpeg','image/webp','text/plain'];
const supportFileAccept = '.pdf,.png,.jpg,.jpeg,.webp,.txt';
const supportDate = value=>new Date(value).toLocaleString('pt-BR');
const supportProtocol = ticket=>'EL-'+String(ticket.protocolo).padStart(6,'0');

function validateSupportFile(file) {
  if (!file?.size) return;
  if (file.size > 10*1024*1024 || !supportFileTypes.includes(file.type)) {
    throw new Error('Use um PDF, PNG, JPEG, WebP ou TXT de até 10 MB.');
  }
}

async function postSupportMessage(ticket, text, file) {
  validateSupportFile(file);
  const row={chamado_id:ticket.id,texto:text.trim()};
  if(file?.size) {
    const path=ticket.id+'/'+session.user.id+'/'+crypto.randomUUID();
    const {error}=await client.storage.from('chamados-anexos').upload(path,file);
    if(error) throw error;
    row.anexo_caminho=path;
    row.anexo_nome=file.name.slice(0,255);
  }
  const {error}=await client.from('chamado_mensagens').insert(row);
  if(error) throw error;
}

let notificationTicket;
const headerDateFormat=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short'});
const headerTimeFormat=new Intl.DateTimeFormat('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',second:'2-digit'});
let headerClockTimer;

function mountAccountStatus(account,customer) {
  const status=document.createElement('div');
  status.className='account-status';
  status.innerHTML='<time></time><small></small>';
  const clock=status.querySelector('time');
  const validity=status.querySelector('small');
  const expiry=[customer?.acesso_ate,customer?.memberExpiry].filter(Boolean).sort()[0];
  validity.textContent=expiry?'Válida até '+expiry.split('-').reverse().join('/'):customer||master?'Validade indeterminada':'Validade indisponível';
  function tick() {
    const now=new Date();
    clock.textContent=headerDateFormat.format(now)+' · '+headerTimeFormat.format(now);
    clock.dateTime=now.toISOString();
  }
  tick();
  headerClockTimer=window.setInterval(tick,1000);
  account.prepend(status);
}

function mountNotifications(account) {
  if (!master && !group) return;
  const area=document.createElement('details');
  area.className='notification-menu';
  area.innerHTML='<summary aria-label="Notificações"><svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9m-11 12a2 2 0 0 0 4 0"/></svg><span class="notification-badge" hidden></span></summary><section class="notification-panel" aria-label="Lista de notificações"><div class="notification-heading"><strong>Notificações</strong></div><div class="notification-items" aria-live="polite"></div></section>';
  account.prepend(area);
  const list=area.querySelector('.notification-items');
  const badge=area.querySelector('.notification-badge');
  const summary=area.querySelector('summary');
  const owner=session.user.id;
  const scope=group;
  const global=master;
  let events=[];
  let read=new Set();
  let busy=false;
  let loaded=false;
  const markAll=action('Marcar todas como lidas',()=>mark(events.filter(event=>!read.has(event.key))),area.querySelector('.notification-heading'));
  markAll.hidden=true;
  area.addEventListener('toggle',()=>{if(area.open) refresh();});
  area.addEventListener('keydown',event=>{
    if(event.key==='Escape' && area.open) {area.open=false;summary.focus();}
  });
  const timer=setInterval(()=>{
    if(!area.isConnected) {clearInterval(timer);return;}
    if(!document.hidden) refresh();
  },20000);
  refresh();

  async function refresh() {
    if(busy) return;
    busy=true;
    if(area.open && !loaded) list.textContent='Carregando notificações…';
    try {
      let tickets=client.from('chamados_clientes').select('id,assunto,criado_em,situacao,atualizado_em');
      let messages=client.from('chamado_mensagens').select('id,enviada_em,suporte,chamados_clientes!inner(id,assunto,grupo_id)').neq('autor_id',owner).eq('suporte',!global);
      if(!global) {
        tickets=tickets.eq('grupo_id',scope).eq('situacao','Resolvido').not('atualizado_em','is',null);
        messages=messages.eq('chamados_clientes.grupo_id',scope);
      }
      let contracts=client.from('contratos_logistica').select('id,versao,dados,atualizado_em').order('atualizado_em',{ascending:false}).limit(100);
      if(!global) contracts=contracts.eq('grupo_id',scope);
      const [ticketResult,messageResult,contractResult]=await Promise.all([
        tickets.order(global?'criado_em':'atualizado_em',{ascending:false}).limit(50),
        messages.order('enviada_em',{ascending:false}).limit(50),global?null:contracts
      ]);
      if(ticketResult.error || messageResult.error) throw ticketResult.error || messageResult.error;
      const logistics=(contractResult?.data??[]).flatMap(row=>{
        const alerts=contractAlerts(row.dados);
        if(!alerts.length) return [];
        const signature=alerts.map(alert=>alert.text).join('|');
        let hash=0;
        for(const char of signature) hash=(Math.imul(hash,31)+char.charCodeAt(0))>>>0;
        return [{key:'logistica:'+row.id+':'+row.versao+':'+hash.toString(16),contract:row.id,title:'Pendências de contrato',subject:row.dados.numero+' · '+row.dados.orgao+' · '+alerts[0].text,date:row.atualizado_em}];
      });
      const incoming=[
        ...logistics,
        ...ticketResult.data.map(ticket=>({key:(global?'chamado:':'solucao:')+ticket.id,ticket:ticket.id,title:global?'Novo chamado':'Chamado resolvido',subject:ticket.assunto,date:global?ticket.criado_em:ticket.atualizado_em})),
        ...messageResult.data.map(entry=>({key:'mensagem:'+entry.id,ticket:entry.chamados_clientes.id,title:global?'Mensagem da empresa':'Mensagem do suporte',subject:entry.chamados_clientes.assunto,date:entry.enviada_em}))
      ].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,50);
      if(!area.isConnected) return;
      let saved=[];
      if(incoming.length) {
        const result=await client.from('notificacoes_lidas').select('evento').in('evento',incoming.map(event=>event.key));
        if(result.error) throw result.error;
        saved=result.data;
      }
      if(!area.isConnected) return;
      const changed=!loaded || JSON.stringify(incoming)!==JSON.stringify(events) || saved.map(row=>row.evento).sort().join()!==[...read].sort().join();
      events=incoming;
      read=new Set(saved.map(row=>row.evento));
      loaded=true;
      if(changed) draw();
    } catch(error) {
      if(!loaded && area.isConnected) list.textContent='Não foi possível carregar as notificações.';
    } finally {busy=false;}
  }

  async function mark(items) {
    const unread=items.filter(event=>!read.has(event.key));
    if(!unread.length) return;
    const {error}=await client.from('notificacoes_lidas').upsert(unread.map(event=>({evento:event.key})),{onConflict:'usuario_id,evento',ignoreDuplicates:true});
    if(error) throw new Error('Não foi possível marcar a notificação como lida.');
    for(const event of unread) read.add(event.key);
    draw();
  }

  function draw() {
    const count=events.filter(event=>!read.has(event.key)).length;
    badge.hidden=!count;
    badge.textContent=String(count);
    summary.setAttribute('aria-label',count?'Notificações, '+count+' não lidas':'Notificações');
    markAll.hidden=!count;
    list.replaceChildren();
    if(!events.length) list.textContent='Nenhuma notificação.';
    for(const event of events) {
      const button=action('',async ()=>{
        await mark([event]);
        area.open=false;
        if(event.contract) {
          logisticsContract=event.contract;
          goTo('logistica');
          return;
        }
        notificationTicket=event.ticket;
        if(global) await openMasterPage('masterSuporte');
        else goTo('ajuda');
      },list);
      button.className='notification-event';
      if(!read.has(event.key)) button.dataset.unread='';
      for(const [tag,value] of [['strong',event.title],['span',event.subject],['small',supportDate(event.date)]]) {
        const field=document.createElement(tag);
        field.textContent=value;
        button.append(field);
      }
    }
  }
}

function renderCustomerTickets(view, attending=false) {
  const section=panel(view,attending?'<h2>Fila de chamados das empresas</h2>':'<h2>Chamados da empresa</h2>');
  section.insertAdjacentHTML('beforeend','<label>Buscar protocolo ou assunto<input type="search"></label>');
  const ticketSearch=section.querySelector('input[type=search]');
  ticketSearch.addEventListener('input',()=>{
    const query=ticketSearch.value.trim().toLowerCase();
    for(const card of list.children) card.hidden=!card.dataset.search.includes(query);
  });
  const list=document.createElement('div');
  const conversation=document.createElement('div');
  let selectedId=notificationTicket;
  notificationTicket=undefined;

  if (!attending) action('Abrir chamado',()=>edit('Abrir chamado',[
    ['contato_nome','Nome','text'],['contato_email','E-mail','email',session.user.email],
    ['contato_whatsapp','WhatsApp com DDD','tel'],['contato_cargo','Cargo','text'],
    ['assunto','Assunto','text'],['descricao','Descrição do problema','textarea'],
    ['anexo','Anexo do problema (até 10 MB)','file']
  ],async ({anexo,...values})=>{
    validateSupportFile(anexo);
    const {data,error}=await client.from('chamados_clientes').insert({...values,grupo_id:group}).select('id').single();
    if(error) throw error;
    selectedId=data.id;
    if(anexo?.size) {
      try { await postSupportMessage(data,'Anexo enviado na abertura do chamado.',anexo); }
      catch (error) { message('Chamado criado. Reenvie o anexo na conversa. '+error.message); }
    }
  },{decorate:form=>{
    Object.entries({contato_nome:120,contato_email:254,contato_whatsapp:40,contato_cargo:120,assunto:180,descricao:5000})
      .forEach(([name,length])=>{form.elements[name].maxLength=length;});
    form.elements.assunto.minLength=3;
    form.elements.descricao.minLength=5;
    form.elements.anexo.accept=supportFileAccept;
  },onSaved:()=>refreshList()}),section,true);

  action('Atualizar chamados',()=>refreshList(),section);
  section.append(list,conversation);

  async function refreshList() {
    let query=client.from('chamados_clientes').select(
      'id,protocolo,grupo_id,contato_nome,contato_email,contato_whatsapp,contato_cargo,assunto,descricao,situacao,resposta,criado_em,atualizado_em'
    ).order('criado_em',{ascending:false});
    if (!attending) query=query.eq('grupo_id',group);
    const {data,error}=await query;
    if(!list.isConnected) return;
    if(error) { list.textContent=error.message; return; }
    list.replaceChildren();
    if(!data.length) list.textContent='Nenhum chamado registrado.';
    if(attending) data.sort((a,b)=>Number(a.situacao==='Resolvido')-Number(b.situacao==='Resolvido'));
    for(const ticket of data) {
      const company=attending ? clients.find(row=>row.id===ticket.grupo_id)?.nome : '';
      const card=panel(list,'<strong>'+supportProtocol(ticket)+' · '+escape(ticket.assunto)+'</strong><p>'+
        (company?escape(company)+' · ':'')+escape(ticket.situacao)+' · '+escape(supportDate(ticket.criado_em))+'</p>');
      card.dataset.search=(supportProtocol(ticket)+' '+ticket.assunto).toLowerCase();
      card.hidden=!card.dataset.search.includes(ticketSearch.value.trim().toLowerCase());
      action('Abrir conversa',()=>{selectedId=ticket.id;return showConversation(ticket);},card);
    }
    const selected=data.find(ticket=>ticket.id===selectedId);
    if(selected) await showConversation(selected);
    else conversation.replaceChildren();
  }

  async function showConversation(ticket) {
    selectedId=ticket.id;
    conversation.replaceChildren();
    const card=panel(conversation,'<h3>Protocolo '+supportProtocol(ticket)+'</h3><p>'+escape(ticket.assunto)+' · '+escape(ticket.situacao)+'</p>');
    for(const [label,value] of [['Nome',ticket.contato_nome],['E-mail',ticket.contato_email],['WhatsApp',ticket.contato_whatsapp],
      ['Cargo',ticket.contato_cargo],['Descrição do problema',ticket.descricao],['Solução registrada',ticket.resposta]]) {
      if (!value) continue;
      const detail=document.createElement('p');
      detail.className='support-text';
      detail.textContent=label+': '+value;
      card.append(detail);
    }
    if(attending) action('Atualizar atendimento',()=>edit('Atualizar atendimento',[
      ['situacao','Situação','select',ticket.situacao,['Aberto','Em atendimento','Resolvido']],
      ['resposta','Solução para a empresa','textarea',ticket.resposta]
    ],async values=>{
      if(values.situacao==='Resolvido' && !values.resposta.trim()) throw new Error('Registre a solução antes de resolver o chamado.');
      const {error}=await client.from('chamados_clientes').update(values).eq('id',ticket.id).select('id').single();
      if(error) throw error;
    },{decorate:form=>{form.elements.resposta.required=false;form.elements.resposta.maxLength=5000;},onSaved:()=>refreshList()}),card);

    const history=panel(card,'<h3>Conversa</h3>');
    const messages=document.createElement('div');
    messages.setAttribute('aria-live','polite');
    history.append(messages);
    action('Atualizar conversa',loadMessages,history);
    const form=document.createElement('form');
    form.innerHTML='<label>Mensagem<textarea name="texto" maxlength="5000" rows="3"></textarea></label>'+
      '<label>Anexar arquivo (até 10 MB)<input name="arquivo" type="file"></label>'+
      '<button type="submit" class="primary">Enviar mensagem</button><p role="status"></p>';
    form.elements.arquivo.accept=supportFileAccept;
    history.append(form);
    form.onsubmit=async event=>{
      event.preventDefault();
      const status=form.querySelector('[role=status]');
      const {texto,arquivo}=Object.fromEntries(new FormData(form));
      event.submitter.disabled=true;
      try {
        status.textContent='';
        if(!texto.trim() && !arquivo.size) throw new Error('Escreva uma mensagem ou selecione um arquivo.');
        await postSupportMessage(ticket,texto,arquivo);
        form.reset();
        status.textContent='Mensagem enviada.';
        await loadMessages();
      } catch(error) {status.textContent=error.message;}
      finally {event.submitter.disabled=false;}
    };
    let messageSignature;
    await loadMessages();
    if (messages.isConnected) {
      const refreshTimer=setInterval(()=>{
        if(!messages.isConnected) {clearInterval(refreshTimer);return;}
        if(!document.hidden) loadMessages().catch(error=>message(error.message));
      },8000);
    }

    async function loadMessages() {
      const {data,error}=await client.from('chamado_mensagens').select('autor_nome,suporte,enviada_em,texto,anexo_caminho,anexo_nome')
        .eq('chamado_id',ticket.id).order('enviada_em').order('id');
      if(!messages.isConnected) return;
      if(error) {messageSignature=undefined;messages.textContent=error.message;return;}
      const signature=JSON.stringify(data);
      if(signature===messageSignature) return;
      messageSignature=signature;
      messages.replaceChildren();
      if(!data.length) messages.textContent='Nenhuma mensagem na conversa.';
      for(const entry of data) {
        const row=panel(messages,'<strong>'+escape(entry.suporte?'Suporte E-Lementar · '+entry.autor_nome:entry.autor_nome)+'</strong><small> · '+escape(supportDate(entry.enviada_em))+'</small>');
        if(entry.texto) {
          const text=document.createElement('p');
          text.className='support-text';
          text.textContent=entry.texto;
          row.append(text);
        }
        if(entry.anexo_caminho) action('Baixar '+entry.anexo_nome,async ()=>{
          const {data,error}=await client.storage.from('chamados-anexos').download(entry.anexo_caminho);
          if(error) throw error;
          const url=URL.createObjectURL(data);
          const link=document.createElement('a');
          link.href=url;link.download=entry.anexo_nome;document.body.append(link);link.click();link.remove();
          setTimeout(()=>URL.revokeObjectURL(url),1000);
        },row);
      }
    }
  }

  refreshList().catch(error=>{if(list.isConnected) list.textContent=error.message;});
}

function renderMasterPage(view) {
  if(page==='masterRelatorios') { renderReportSettings(view); return; }
  if(page==='masterSuporte') { renderCustomerTickets(view,true); return; }
  const commercial = {masterAssinaturas:'assinatura',masterFinanceiro:'cobranca'};
  if (page==='clientes' || commercial[page]) {
    renderCommercialDashboard(view,commercial[page]);
    return;
  }
  if (page==='masterEmpresas' || page==='masterAcessos' || page==='masterAparencia') {
    renderClients(view);
    return;
  }
  if(page==='masterComercial') {
    renderMasterRecords(view,'interesses_comerciais','id,nome,empresa,email,interesse,situacao,criado_em',100,(section,row)=>{
      const card=panel(section,'<strong>'+escape(row.empresa)+'</strong><p>'+escape(row.nome)+' · '+escape(row.email)+'</p><p>'+
        (row.interesse==='contratacao'?'Proposta comercial':'Demonstração')+' · '+escape(row.situacao)+' · '+escape(new Date(row.criado_em).toLocaleString('pt-BR'))+'</p>');
      action('Alterar situação',()=>edit('Situação da solicitação',[
        ['situacao','Situação','select',row.situacao,['Novo','Em contato','Convertido','Encerrado']]
      ],async values=>{
        const {error}=await client.from('interesses_comerciais').update(values).eq('id',row.id).select('id').single();
        if(error) throw error;
      }),card);
    });
    return;
  }
  if(page==='masterAuditoria') {
    const labels={gestao_comercial:'Financeiro, assinaturas e suporte',interesses_comerciais:'Solicitações comerciais',aparencia_telas:'Aparência',chamados_clientes:'Atendimento de chamados',grupos:'Acesso da empresa',membros:'Acesso e alias do usuário'};
    renderMasterRecords(view,'auditoria_plataforma','ocorrido_em,usuario_id,recurso,acao,registro',100,(section,row)=>{
      panel(section,'<strong>'+escape(labels[row.recurso]??row.recurso)+'</strong><p>'+
        (row.acao==='INSERT'?'Cadastro':'Alteração')+' · '+escape(new Date(row.ocorrido_em).toLocaleString('pt-BR'))+
        '</p><small>Usuário '+escape(row.usuario_id??'Sistema')+' · Registro '+escape(row.registro)+'</small>');
    });
    return;
  }
  const currentVersion=new URL(import.meta.url).searchParams.get('v') ?? 'indisponível';
  const section=panel(view,'<h2>Versão carregada</h2><p>'+escape(currentVersion)+'</p><p role="status"></p>');
  action('Verificar atualização',async ()=>{
    await checkVersion();
    section.querySelector('[role=status]').textContent=availableVersion?'Versão disponível: '+availableVersion:'Nenhuma versão mais recente foi detectada.';
  },section,true);
}

async function openAccessConfiguration(parent,company,byUser) {
  const settings=await call('licitacoes_configuracao_acesso',{empresa:company.id});
  if (!byUser) {
    edit('Acesso da empresa · '+company.nome,[
      ['modo','Situação','select',settings.modo,[['ativo','Ativo'],['leitura','Somente leitura'],['bloqueado','Bloqueado']]],
      ['validade','Válido até (opcional)','date',settings.validade]
    ],values=>call('licitacoes_salvar_acesso',{empresa:company.id,modo:values.modo,validade:values.validade||null}));
    return;
  }
  if(!parent.isConnected) return;
  parent.replaceChildren();
  const names=await call('licitacoes_nomes_equipe',{empresa:company.id});
  if(!parent.isConnected) return;
  for(const member of settings.usuarios) {
    const card=panel(parent,'<strong>'+escape(member.alias||member.email)+'</strong><p>'+
      escape(member.email)+' · '+escape(profileLabel(member.papel,names[member.id]?.cargo))+' · '+(member.habilitado?'Habilitado':'Bloqueado')+
      (member.validade?' · Válido até '+escape(member.validade.split('-').reverse().join('/')):'')+'</p>');
    action('Configurar acesso e alias',()=>edit('Acesso de '+member.email,[
      ['modo','Situação','select',member.habilitado?'ativo':'bloqueado',[['ativo','Ativo'],['bloqueado','Bloqueado']]],
      ['validade','Válido até (opcional)','date',member.validade],
      ['apelido','Alias na empresa','text',member.alias]
    ],values=>call('licitacoes_salvar_acesso',{empresa:company.id,integrante:member.id,modo:values.modo,
      validade:values.validade||null,apelido:values.apelido}),{
      decorate:form=>{form.elements.apelido.required=false;form.elements.apelido.maxLength=80;},
      onSaved:()=>openAccessConfiguration(parent,company,true).catch(error=>message(error.message))
    }),card);
  }
}

function renderClients(view) {
  if(page==='masterAcessos') { renderMasterAccess(view); return; }
  const section = panel(view,'<h2>Empresas cadastradas</h2>');
  if(page==='masterEmpresas') action('Cadastrar empresa cliente', () => edit('Nova empresa cliente', [
    ['nome_cliente','Nome da empresa','text'],['email_admin','E-mail do administrador cadastrado','email']
  ], async values => {
    await call('licitacoes_criar_cliente',values);
    clients = await call('licitacoes_clientes');
  }), section,true);
  for (const customer of clients) {
    const card=panel(section,'<strong>'+escape(customer.nome)+'</strong><p>'+escape(customer.integrantes)+' integrante(s)</p>');
    if(page==='masterEmpresas') action('Controlar acesso da empresa',()=>openAccessConfiguration(card,customer,false),card);
    if(page==='masterAparencia') action('Configurar aparência',()=>{
      const existing=card.querySelector('[data-aparencia]');
      if(existing) {existing.remove();return;}
      const settings=document.createElement('div');
      settings.dataset.aparencia='';
      card.append(settings);
      renderVisualPreview(settings,customer.id);
    },card);

  }
}

let selectedAccessCompany;
let selectedAccessView='profiles';

function renderMasterAccess(view) {
  const section=panel(view,'<h2>Controle de acesso por empresa</h2>');
  if(!clients.length) { section.append('Nenhuma empresa cadastrada.'); return; }
  const companyLabel=document.createElement('label');
  const companySelect=document.createElement('select');
  companyLabel.append('Empresa',companySelect);
  for(const customer of clients) companySelect.add(new Option(customer.nome,customer.id));
  companySelect.value=clients.find(customer=>customer.id===selectedAccessCompany)?.id??clients[0].id;
  companySelect.onchange=()=>{ selectedAccessCompany=companySelect.value; render(); };
  section.append(companyLabel);
  const controls=document.createElement('div');
  controls.className='line';
  section.append(controls);
  for(const [key,label] of [['profiles','Perfis e acesso por tela'],['accounts','Usuários, validade e aliases']]) {
    const button=action(label,()=>{ selectedAccessView=key; render(); },controls,selectedAccessView===key);
    button.setAttribute('aria-pressed',String(selectedAccessView===key));
  }
  const customer=clients.find(item=>item.id===companySelect.value);
  if(selectedAccessView==='profiles') { mountCargoManagement(section,customer.id,true); return; }
  const card=panel(section,'<p>Selecione um usuário para trocar seu perfil, ajustar ações de cadastro ou conferir a validade do acesso.</p>');
  const members=panel(card,'<h3>Permissões por conta</h3>');
  const permissions=panel(card,'<h3>Acesso e aliases</h3>');
  const refreshMembers=()=>showMemberProfiles(members,customer.id,async ()=>{
    if(permissions.dataset.loaded) await openAccessConfiguration(permissions,customer,true);
  });
  action('Consultar integrantes',refreshMembers,card);
  action('Configurar acesso dos usuários',async ()=>{
    await openAccessConfiguration(permissions,customer,true);
    permissions.dataset.loaded='true';
  },card);
  refreshMembers().catch(error=>message(error.message));
}

async function showMemberProfiles(section,customerId,afterChange) {
  const [members,names]=await Promise.all([call('licitacoes_equipe',{cliente:customerId}),call('licitacoes_nomes_equipe',{empresa:customerId})]);
  if(!section.isConnected) return;
  section.replaceChildren();
  renderMemberProfiles(section,customerId,members,()=>Promise.all([showMemberProfiles(section,customerId,afterChange),afterChange?.()]).catch(error=>message(error.message)),names);
}

const registryPermissionResources=[['catalogo','Produtos / Serviços'],['orgaos_compradores','Prefeituras / Clientes']];
const registryPermissionActions=[['visualizar','Visualizar'],['cadastrar','Cadastrar'],['editar','Editar'],['excluir','Excluir']];

async function editRegistryPermissions(customerId,member,refresh) {
  const identity={cliente:customerId,integrante:member.usuario_id};
  const saved=await call('licitacoes_permissoes_cadastro',identity);
  const fields=registryPermissionResources.flatMap(([resource,label])=>registryPermissionActions.map(([permission,verb])=>{
    const current=saved.find(row=>row.recurso===resource && row.acao===permission);
    return [resource+'_'+permission,label+' — '+verb,'select',current?.permitido===false?'bloquear':'perfil',
      [['perfil','Seguir o perfil'],['bloquear','Bloquear']]];
  }));
  edit('Permissões de '+member.email,fields,async values=>{
    const permissoes=registryPermissionResources.flatMap(([recurso])=>registryPermissionActions
      .filter(([acao])=>values[recurso+'_'+acao]==='bloquear').map(([acao])=>({recurso,acao,permitido:false})));
    await call('licitacoes_salvar_permissoes_cadastro',{...identity,permissoes});
  },{onSaved:refresh});
}

function renderMemberProfiles(section,customerId,members,refresh,names={}) {
  for(const member of members) {
    const card=panel(section,'<strong>'+escape(member.email)+'</strong><p>'+escape(profileLabel(member.papel,names[member.usuario_id]?.cargo))+'</p>');
    if(!['operador','leitor'].includes(member.papel)) continue;
    action('Permissões de cadastros',()=>editRegistryPermissions(customerId,member,refresh),card);
    action('Alterar perfil',async ()=>{
      const state=await call('licitacoes_painel_cargos',{empresa:customerId});
      const current=state.integrantes.find(row=>row.id===member.usuario_id);
      if(!current) throw new Error('Integrante não encontrado.');
      const presets=Object.keys(accessPresets).filter(nome=>!state.cargos.some(cargo=>cargo.nome===nome));
      const options=[['base:operador','Operador · acesso básico'],['base:leitor','Leitor · somente consulta'],
        ...state.cargos.map(cargo=>[cargo.id,cargo.nome]),...presets.map(nome=>['modelo:'+nome,nome])];
      edit('Permissões da conta '+member.email,[
        ['perfil','Perfil','select',current.cargo_id??'base:'+member.papel,options]
      ],async ({perfil})=>{
        let cargo=perfil;
        if(perfil.startsWith('modelo:')) {
          const nome=perfil.slice(7);
          await call('licitacoes_gravar_cargo',{empresa:customerId,nome_cargo:nome,regras_cargo:presetScreenRules(accessPresets[nome])});
          const updated=await call('licitacoes_painel_cargos',{empresa:customerId});
          cargo=updated.cargos.find(row=>row.nome===nome).id;
        }
        const base=perfil.startsWith('base:')?perfil.slice(5):'operador';
        if(base!==current.papel) await call('licitacoes_alterar_perfil',{cliente:customerId,integrante:member.usuario_id,novo_perfil:base});
        await call('licitacoes_atribuir_cargo',{empresa:customerId,integrante:member.usuario_id,cargo:perfil.startsWith('base:')?null:cargo});
      },{onSaved:refresh});
    },card);
  }
}

function editOwnAccount() {
  const user=session.user;
  edit('Editar minha conta',[
    ['username','Nome de usuário','text',user.user_metadata?.username],
    ['email','E-mail da conta','email',user.email]
  ],async ({username,email})=>{
    const fields={data:{username:username.trim()}};
    if(email.trim().toLowerCase()!==user.email.toLowerCase()) fields.email=email.trim();
    if(!fields.data.username) throw new Error('Informe um nome de usuário.');
    const {data,error}=await client.auth.updateUser(fields);
    if(error) throw error;
    session={...session,user:data.user};
    return fields.email ? 'Confira sua caixa de entrada para confirmar a alteração do e-mail.' : 'Nome de usuário atualizado.';
  },{onSaved:result=>{openTeam().then(()=>message(result)).catch(error=>message(error.message));}});
}

function editOwnPassword() {
  edit('Alterar senha',[
    ['password','Nova senha','password'],
    ['confirmacao','Confirme a nova senha','password']
  ],async ({password,confirmacao})=>{
    if(password!==confirmacao) throw new Error('As senhas precisam ser iguais.');
    if(password.length<8) throw new Error('Use pelo menos oito caracteres.');
    const {error}=await client.auth.updateUser({password});
    if(error) throw error;
  },{decorate:form=>{
    for(const field of form.querySelectorAll('input[type=password]')) field.autocomplete='new-password';
  },onSaved:()=>message('Senha atualizada.')});
}

function renderMyAccount(view) {
  const user=session.user;
  const card=panel(view,'<h2>Minha conta</h2><p>'+escape(user.user_metadata?.username||user.email.split('@')[0])+' · '+escape(user.email)+'</p>');
  if(isDemo() && user.email==='demo@example.com') {
    card.insertAdjacentHTML('beforeend','<p class="muted">O e-mail e a senha da conta compartilhada de demonstração são fixos.</p>');
    return;
  }
  action('Editar nome e e-mail',editOwnAccount,card);
  action('Alterar minha senha',()=>editOwnPassword(),card);
}

function renderDemoTeam(view) {
  const key='licitacoes-equipe-simulada-demo';
  let members;
  try { members=JSON.parse(localStorage.getItem(key)??'[]'); }
  catch { members=[]; }
  const section=panel(view,'<h2>Equipe de demonstração</h2><p class="muted">Crie integrantes fictícios para testar os perfis. Os registros ficam neste navegador e não geram acesso ao sistema.</p>');
  const profiles=Object.keys(accessPresets);
  function editMember(member) {
    edit(member?'Editar integrante fictício':'Criar integrante fictício',[
      ['nome','Nome fictício','text',member?.nome],
      ['perfil','Perfil','select',member?.perfil??profiles[0],profiles]
    ],({nome,perfil})=>{
      nome=nome.trim();
      if(!nome) throw new Error('Informe um nome fictício.');
      if(member) members=members.map(row=>row.id===member.id?{...row,nome,perfil}:row);
      else members.push({id:crypto.randomUUID(),nome,perfil});
      localStorage.setItem(key,JSON.stringify(members));
    });
  }
  action('Criar integrante fictício',()=>editMember(),section,true);
  for(const member of members) {
    const row=panel(section,'<strong>'+escape(member.nome)+'</strong><p>'+escape(member.perfil)+'</p>');
    action('Editar integrante',()=>editMember(member),row);
    action('Remover integrante',()=>edit('Remover '+member.nome+' da equipe de demonstração',[],()=>{
      localStorage.setItem(key,JSON.stringify(members.filter(entry=>entry.id!==member.id)));
    }),row);
  }
}

function renderTeam(view) {
  renderMyAccount(view);
  if(isDemo() && session.user.email==='demo@example.com') { renderDemoTeam(view); return; }
  if(groupRole()!=='admin') return;
  const section=panel(view,'<h2>Integrantes</h2><p class="muted">Vincule contas cadastradas à empresa e defina seus cargos.</p>');
  section.classList.add('settings-section');
  action('Vincular integrante',async ()=>{
    const state=await call('licitacoes_painel_cargos',{empresa:group});
    const options=[['base','Sem cargo personalizado'],...state.cargos.map(cargo=>[cargo.id,cargo.nome])];
    edit('Vincular integrante',[
      ['nome_usuario','Nome de exibição','text'],
      ['email_membro','E-mail da conta cadastrada','email'],
      ['papel_membro','Perfil básico','select','operador',[['operador','Operador'],['leitor','Leitor']]],
      ['cargo','Cargo na empresa','select','base',options]
    ],async ({cargo,...values})=>{
      await call('licitacoes_vincular_integrante',{...values,cliente:group,cargo:cargo==='base'?null:cargo});
    },{onSaved:()=>openTeam().catch(error=>message(error.message)),decorate:form=>{
      form.elements.nome_usuario.minLength=2;
      form.elements.nome_usuario.maxLength=80;
      const hint=document.createElement('p');
      hint.className='muted';
      hint.textContent='O integrante precisa ter uma conta confirmada. Você pode criar cargos personalizados na seção Cargos e regras da equipe.';
      form.prepend(hint);
    }});
  },section,true);
  for(const member of team) {
    const details=teamNames[member.usuario_id];
    const card=panel(section,'<strong>'+escape(details?.nome||member.email)+'</strong><p>'+escape(member.email)+' · '+escape(details?.cargo||({admin:'Administrador',operador:'Operador',leitor:'Leitor'}[member.papel]))+'</p>');
    action('Editar nome na empresa',()=>edit('Nome na empresa',[['nome','Nome de exibição','text',details?.nome]],
      values=>call('licitacoes_renomear_integrante',{empresa:group,integrante:member.usuario_id,nome:values.nome}),
      {onSaved:()=>openTeam().catch(error=>message(error.message))}),card);
    if(member.papel!=='admin') renderMemberProfiles(card,group,[member],()=>openTeam(),teamNames);
  }
  mountCargoManagement(view,group);
}

const operationDefaults={antecedencia:7,margem:18};
function operationSettings() {
  return {...operationDefaults,...screenAppearance.find(row=>row.tela==='preferenciasOperacionais')?.ajustes};
}
function renderOperationSettings(section) {
  const form=document.createElement('form');
  form.className='operation-fields';
  form.innerHTML='<label>Dias de antecedência no painel<input name="antecedencia" type="number" min="0" max="90" step="1" required></label><label>Margem inicial para novos itens (%)<input name="margem" type="number" min="0" max="99.99" step="0.01" required></label><div><button class="primary">Salvar padrões</button></div><p role="status"></p>';
  const settings=operationSettings();
  form.elements.antecedencia.value=settings.antecedencia;
  form.elements.margem.value=settings.margem;
  section.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();
    event.submitter.disabled=true;
    const status=form.querySelector('[role=status]');
    try {
      const ajustes={antecedencia:form.elements.antecedencia.valueAsNumber,margem:form.elements.margem.valueAsNumber,salvoEm:new Date().toISOString()};
      const {error}=await client.from('aparencia_telas').upsert({grupo_id:group,tela:'preferenciasOperacionais',ajustes});
      if(error) throw error;
      await load();
      status.textContent='Padrões salvos em '+supportDate(ajustes.salvoEm)+'.';
    } catch(error) {status.textContent=error.message;}
    finally {event.submitter.disabled=false;}
  };
  if(settings.salvoEm) form.querySelector('[role=status]').textContent='Última alteração em '+supportDate(settings.salvoEm)+'.';
}

function processSummary(parent,row,next) {
  const summary=document.createElement('p');
  summary.className='process-context';
  summary.textContent=[row.numero && 'Processo '+row.numero,row.numero_pregao && 'Pregão '+row.numero_pregao,
    row.sessao && 'Sessão '+row.sessao.split('-').reverse().join('/'),next].filter(Boolean).join(' · ');
  parent.append(summary);
}
function renderUpcoming(view) {
  const section=panel(view,'<h2>Prazos e pendências</h2>');
  section.classList.add('settings-section');
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
  const end=new Date(today+'T12:00:00Z');
  end.setUTCDate(end.getUTCDate()+Number(operationSettings().antecedencia));
  const rows=db.editais.filter(row=>row.sessao && row.sessao>=today && row.sessao<=end.toISOString().slice(0,10)
    && row.status!=='Reprovado' && !db.disputas.some(d=>d.edital_id===row.id && d.etapa===2)).sort((a,b)=>a.sessao.localeCompare(b.sessao));
  for(const row of rows) {
    const card=panel(section,'<strong>'+escape(row.orgao)+'</strong>');
    processSummary(card,row,row.status==='Aprovado'?proposalStages[proposalStage(row)]:row.status);
    if(row.status==='Aprovado' && screenAllowed('propostas')) action('Abrir proposta',()=>{page='propostas';openWorkflowProposal(row);},card);
    else if(screenAllowed('editais')) action('Abrir captação',()=>goTo('editais'),card);
  }
  if(!rows.length) section.append('Nenhuma sessão no período configurado.');
}

const settingsCategories=[
  ['Empresa e documentos',[]],
  ['Padrões operacionais',[]],
  ['Aparência e navegação',Object.keys(screens)],
  ['Configurações de relatórios',[]]
];
let selectedSettings=0;

const canManageParticipants = () => canWrite() || (isDemo() && session?.user?.email==='demo@example.com' &&
  groupRole()==='operador' && screenAccess.configuracoes==='consulta');
const participantAction = (label, run, parent, primary) => {
  if(canManageParticipants()) action(label,run,parent,primary);
};
function renderCompanySettings(view) {
  const nav=document.createElement('nav');
  nav.className='settings-nav';
  nav.setAttribute('aria-label','Seções de configurações');
  const body=document.createElement('div');
  view.append(nav,body);
  const tabs=settingsCategories.map(([label],index)=>action(label,()=>show(index),nav));
  show(selectedSettings);

  function show(index) {
    selectedSettings=index;
    tabs.forEach((button,i)=>button.setAttribute('aria-current',i===index?'true':'false'));
    body.replaceChildren();
    const [label,modules]=settingsCategories[index];
    const section=panel(body,'<h2>'+label+'</h2>');
    section.classList.add('settings-section');
    if(index===0) {
      section.insertAdjacentHTML('beforeend','<h3>CNPJs participantes</h3><p class="muted">Gerencie os dados e a identidade dos documentos de cada CNPJ.</p>');
      participantAction('Cadastrar empresa participante',()=>company(),section,true);
      if(!db.empresas.length) section.insertAdjacentHTML('beforeend','<p class="muted">Nenhum CNPJ cadastrado.</p>');
      for(const companyRecord of db.empresas) {
        const card=panel(section,'<strong>'+escape(companyRecord.nome)+'</strong><p>'+escape(companyRecord.cnpj)+' · '+escape(companyRecord.porte)+'</p>');
        participantAction('Editar empresa',()=>company(companyRecord),card);
        renderCompanyRepresentatives(card,companyRecord);
        participantAction('Logo e dados para propostas',()=>companyProposalSettings(companyRecord),card);
      }
    }
    if(client && canWrite() && index===1) renderOperationSettings(section);
    if(client && canWrite() && index===2) renderVisualPreview(section,group,modules);
    if(index===3) renderReportSettings(section);
  }
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

const proposalStages = ['A montar','Em preparação','Vincular documentação','Conferência 01','Conferência 02','Enviar para disputa'];
const proposalStage = row=>Number(row.etapa_proposta ?? 0);

async function moveProposal(row,destination) {
  const origin = proposalStage(row);
  if (Math.abs(destination-origin)!==1) throw new Error('Mova a proposta uma coluna por vez.');
  const {error} = await client.rpc('mover_proposta',{p_edital:row.id,p_origem:origin,p_destino:destination});
  if (error) throw error;
  await load();
  render();
  if (destination===5) {
    const scope = {grupo_id:row.grupo_id,empresa_id:row.empresa_id,edital_id:row.id};
    const {data,error} = await client.from('anexos_proposta').select('arquivo_id').match(scope);
    if (error) throw error;
    await downloadProposalPackage(row,scope,new Set(data.map(link=>link.arquivo_id)));
  }
}

function proposalControls(parent,row) {
  if (!client || !canWrite()) return;
  const stage = proposalStage(row);
  if (stage>0) action('Voltar para '+proposalStages[stage-1],()=>moveProposal(row,stage-1),parent);
  if (stage<5) action(proposalStages[stage+1],()=>moveProposal(row,stage+1),parent,true);
}

const quoteStages = ['Em cotação','Revisão','Enviado'];
const budgetStages = ['Em elaboração','Revisão e assinatura','Enviado'];
const isBudget = row=>row.tipo==='orcamento';
const quoteDate = new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'short',timeZone:'America/Sao_Paulo'});

async function updateQuote(row,values) {
  if (!client) return save('cotacoes',values,row.id);
  const {data,error} = await client.from('cotacoes').update(values).match({grupo_id:group,id:row.id,revisao:row.revisao}).select('id').maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('A cotação mudou. Atualize a tela antes de salvar.');
  await load();
  return data.id;
}

function budgetForm(view,row) {
  edit(row.id?'Editar orçamento':'Novo orçamento',[
    ['titulo','Referência ou assunto do pedido','text',row.titulo],
    ['empresa_id','Empresa emitente','select',row.empresa_id ?? db.empresas[0]?.id,db.empresas.map(company=>[company.id,company.nome+' · '+company.cnpj])],
    ['orgao_id','Órgão solicitante','select','',[]],
    ['email','E-mail do órgão','email',row.email],
    ['observacao','Condições comerciais e observações','textarea',row.observacao]
  ],async values=>{
    const orgao=db.orgaos_compradores.find(entry=>entry.id===values.orgao_id);
    if (!values.empresa_id || !orgao || !values.titulo.trim()) throw new Error('Informe a referência, a empresa emitente e o órgão solicitante.');
    const data={...values,titulo:values.titulo.trim(),fornecedor:orgao.nome};
    return row.id?updateQuote(row,data):save('cotacoes',client?{...data,tipo:'orcamento'}:{...data,tipo:'orcamento',etapa:0,itens:[],historico:[]});
  },{onSaved:id=>openQuote(view,id),decorate:form=>registryPicker(form,{name:'orgao_id',table:'orgaos_compradores',label:'Buscar prefeitura ou órgão',
    placeholder:'Selecione um órgão solicitante',title:'Cadastrar órgão comprador',fields:name=>agencyFields({nome:name}),saveRecord:values=>saveAgency(values),
    entryLabel:entry=>entry.nome+' · '+entry.cnpj,searchText:entry=>[entry.nome,entry.cnpj].join(' '),initial:row.orgao_id??'',
    apply:entry=>{const email=form.elements.namedItem('email'); if (entry?.email && !email.value) email.value=entry.email;}})});
}

const budgetPdfItem=item=>({...item,codigo:item.codigo,preco_unitario:item.preco});
function renderBudgetActions(section,view,row) {
  const priced=row.itens.length && row.itens.every(item=>item.preco!=null);
  if (priced) action('Baixar orçamento em PDF',()=>downloadProposalPdf({
    ...row,orgao:row.fornecedor,numero:row.titulo,objeto:row.titulo
  },row.itens.map(budgetPdfItem),{budget:true}),section);
  if (priced) section.insertAdjacentHTML('beforeend','<p><strong>Total do orçamento: '+money.format(total(row.itens.map(budgetPdfItem)))+'</strong></p>');
  if (row.assinado_em) action('Baixar orçamento assinado',async()=>{
    const {data,error}=await client.from('cotacoes').select('pdf_assinado').match({grupo_id:group,id:row.id}).single();
    if (error) throw error;
    if (!data.pdf_assinado) throw new Error('O PDF assinado não está disponível.');
    saveQuoteFile(new Blob([pdfBytes(data.pdf_assinado)],{type:'application/pdf'}),'orcamento-assinado-'+row.id.slice(0,8)+'.pdf');
  },section);
  if (client && row.etapa===1 && priced) {
    section.insertAdjacentHTML('beforeend','<p>Baixe o PDF, assine digitalmente ou à mão e anexe o documento assinado. Envie o arquivo ao órgão pelo canal solicitado e depois marque como enviado.</p>');
    writeAction(row.assinado_em?'Substituir PDF assinado':'Anexar orçamento assinado',()=>edit('Anexar orçamento assinado',
      [['arquivo','Orçamento assinado em PDF','file']],async ({arquivo})=>updateQuote(row,{pdf_assinado:await encodePdf(arquivo)}),
      {onSaved:id=>openQuote(view,id)}),section,true);
  }
}

function quoteForm(view,row={}) {
  if (page==='orcamento') return budgetForm(view,row);
  edit(row.id?'Editar cotação':'Nova cotação',[
    ['titulo','Título da cotação','text',row.titulo],
    ['empresa_id','Empresa solicitante','select',row.empresa_id ?? db.empresas[0]?.id,db.empresas.map(company=>[company.id,company.nome+' · '+company.cnpj])],
    ['fornecedor','Fornecedor','text',row.fornecedor],
    ['email','E-mail do fornecedor','email',row.email],
    ['observacao','Instruções para o fornecedor','textarea',row.observacao]
  ], async values=>{
    values.titulo=values.titulo.trim();
    values.fornecedor=values.fornecedor.trim();
    if (!values.empresa_id) throw new Error('Cadastre uma empresa solicitante nas Configurações.');
    if (!values.titulo || !values.fornecedor) throw new Error('Informe o título e o fornecedor.');
    return row.id ? updateQuote(row,values) : save('cotacoes',client?values:{...values,etapa:0,itens:[],historico:[]});
  },{onSaved:id=>openQuote(view,id)});
}

function quoteItem(view,row,item) {
  const budget=isBudget(row);
  const fields = item ? [
    ['quantidade','Quantidade solicitada','number',item.quantidade],
    ['preco',budget?'Preço unitário ofertado (R$)':'Preço unitário retornado pelo fornecedor','number',item.preco]
  ] : [
    ['catalogo_id','Produto ou serviço','select','',[]],
    ['quantidade','Quantidade solicitada','number',1]
  ];
  edit(item?'Editar item da cotação':'Adicionar item do catálogo',fields,async values=>{
    if (!item && row.itens.some(entry=>entry.catalogo_id===values.catalogo_id)) throw new Error('Este item já está na cotação.');
    const source = db.catalogo.find(entry=>entry.id===values.catalogo_id);
    if (!item && !source) throw new Error('Selecione um item do catálogo.');
    const quantidade = Number(values.quantidade);
    const preco = item ? (values.preco ? Number(values.preco) : null) : budget && source ? financialPrice(source)?.final ?? null : null;
    if (!Number.isFinite(quantidade) || quantidade<=0 || (preco!==null && (!Number.isFinite(preco) || preco<0 || preco>=1e10))) throw new Error('Confira a quantidade e o preço informado.');
    const picked = item ?? {catalogo_id:source.id,codigo:source.codigo,descricao:source.descricao,unidade:source.unidade,marca:source.marca,custo_base:Number(source.custo)};
    const entry = {...picked,quantidade,preco};
    const itens = item ? row.itens.map(existing=>existing.catalogo_id===item.catalogo_id?entry:existing) : [...row.itens,entry];
    return updateQuote(row,{itens});
  },{onSaved:id=>openQuote(view,id),decorate:form=>{
    if (item) {
      form.elements.namedItem('preco').required=budget;
      if (row.etapa===2) form.elements.namedItem('quantidade').readOnly=true;
      return;
    }
    registryPicker(form,{name:'catalogo_id',table:'catalogo',label:'Buscar no catálogo',placeholder:'Selecione um produto ou serviço',
      title:'Cadastrar produto ou serviço',fields:descricao=>catalogFields({descricao}),saveRecord:values=>saveCatalog(values),
      entryLabel:entry=>entry.codigo+' · '+entry.descricao,searchText:entry=>[entry.codigo,entry.descricao,entry.marca].join(' ')});
  }});
}

async function moveQuote(row,destination) {
  if (Math.abs(destination-row.etapa)!==1) throw new Error('Mova a cotação uma coluna por vez.');
  if (destination>row.etapa && !row.itens.length) throw new Error('Inclua pelo menos um item do catálogo.');
  if (isBudget(row) && destination===2 && !row.assinado_em) throw new Error('Anexe o orçamento assinado antes de marcar como enviado.');
  const values={etapa:destination};
  if (!client) values.historico=[...row.historico,{origem:row.etapa,destino:destination,usuario:'Demonstração',data:new Date().toISOString()}];
  await updateQuote(row,values);
}

function renderQuotes(view) {
  if (unavailableRegistries.has('cotacoes')) {
    panel(view,'<p>As cotações aguardam a atualização do banco de dados.</p>');
    return;
  }
  const budget=page==='orcamento';
  const stages=budget?budgetStages:quoteStages;
  const records=db.cotacoes.filter(row=>isBudget(row)===budget);
  writeAction(budget?'Novo orçamento':'Nova cotação',()=>quoteForm(view),byId('page-actions'),true);
  const grid=document.createElement('section');
  grid.style.cssText='display:grid;grid-template-columns:repeat(3,minmax(210px,1fr));gap:12px;overflow:auto';
  for (const [index,stage] of stages.entries()) {
    const rows=records.filter(row=>row.etapa===index);
    const lane=document.createElement('section');
    lane.className='lane';
    lane.innerHTML='<h3>'+stage+' · '+rows.length+'</h3>';
    if (canWrite()) {
      lane.ondragover=event=>event.preventDefault();
      lane.ondrop=event=>{
        event.preventDefault();
        const row=records.find(record=>record.id===event.dataTransfer.getData('text/plain'));
        if (row && row.etapa!==index) moveQuote(row,index).then(render).catch(error=>message(error.message));
      };
    }
    for (const row of rows) {
      const card=panel(lane,'<strong>'+escape(row.titulo)+'</strong><p>'+escape(row.fornecedor)+'</p><p>'+row.itens.length+' item(ns)</p>');
      card.classList.add('card');
      card.draggable=canWrite();
      card.ondragstart=event=>event.dataTransfer.setData('text/plain',row.id);
      action(budget?'Abrir orçamento':'Abrir cotação',()=>openQuote(view,row.id),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

function openQuote(view,id) {
  const row=db.cotacoes.find(entry=>entry.id===id);
  if (!row || page!==(isBudget(row)?'orcamento':'cotacoes')) return;
  const budget=isBudget(row);
  const stages=budget?budgetStages:quoteStages;
  view.replaceChildren();
  byId('page-actions').replaceChildren();
  action('Voltar ao quadro',render,byId('page-actions'));
  demoDelete('cotacoes',row.id,byId('page-actions'));
  const section=panel(view,'<h2>'+escape(row.titulo)+'</h2><p>'+escape(row.fornecedor)+' · '+stages[row.etapa]+'</p>');
  if (row.observacao) section.insertAdjacentHTML('beforeend','<p>'+escape(row.observacao)+'</p>');
  if (row.etapa<2) {
    writeAction(budget?'Editar orçamento':'Editar cotação',()=>quoteForm(view,row),section);
    writeAction('Adicionar item do catálogo',()=>quoteItem(view,row),section,true);
  }
  if (row.etapa>0) writeAction('Voltar para '+stages[row.etapa-1],async()=>{await moveQuote(row,row.etapa-1);openQuote(view,id);},section);
  if (row.etapa<2) writeAction(row.etapa===1?'Marcar como enviado':'Mover para revisão',async()=>{await moveQuote(row,row.etapa+1);openQuote(view,id);},section);
  if (budget) renderBudgetActions(section,view,row);
  if (!budget && row.itens.length) {
    action('Baixar PDF para o fornecedor',()=>downloadQuote(row,'pdf'),section);
    action('Baixar XML para o fornecedor',()=>downloadQuote(row,'xml'),section);
  }
  if (!budget && row.etapa===2 && row.itens.some(item=>item.preco!=null)) action('Ver preços no Financeiro',()=>{page='financeiro';render();},section);
  const table=quoteTable(section,['Código','Produto ou serviço','Quantidade','Unidade',budget?'Preço ofertado':'Preço retornado',...(budget?['Total']:[]),'Ações']);
  for (const item of row.itens) {
    const line=table.insertRow();
    for (const value of [item.codigo,item.descricao,decimal.format(item.quantidade),item.unidade,item.preco == null?'Aguardando preço':money.format(item.preco),...(budget?[item.preco==null?'—':money.format(total([budgetPdfItem(item)]))]:[])]) line.insertCell().textContent=value;
    const controls=line.insertCell();
    if (item.aplicado_em) controls.textContent='Custo aplicado em '+quoteDate.format(new Date(item.aplicado_em));
    else if (!budget || row.etapa<2) writeAction(row.etapa===2?'Registrar preço':'Editar item',()=>quoteItem(view,row,item),controls);
    if (row.etapa<2 && !item.aplicado_em) writeAction('Remover',async()=>{
      await updateQuote(row,{itens:row.itens.filter(other=>other.catalogo_id!==item.catalogo_id)});
      openQuote(view,id);
    },controls);
  }
  if (row.historico.length) {
    const history=panel(view,'<h3>Histórico de movimentações</h3>');
    const list=document.createElement('ul');
    list.style.cssText='list-style:none;margin:4px 0;padding:0;font-size:9pt;line-height:1.45';
    for(const entry of [...row.historico].reverse()) {
      const line=document.createElement('li');
      line.textContent=[entry.origem==null?stages[entry.destino]:stages[entry.origem]+' → '+stages[entry.destino],entry.usuario,quoteDate.format(new Date(entry.data))].filter(Boolean).join(' · ');
      list.append(line);
    }
    history.append(list);
  }
}

function quoteTable(parent,headers) {
  const wrap=document.createElement('div');
  wrap.className='scroll';
  wrap.innerHTML='<table><thead><tr>'+headers.map(label=>'<th scope="col">'+label+'</th>').join('')+'</tr></thead><tbody></tbody></table>';
  parent.append(wrap);
  return wrap.querySelector('tbody');
}

function saveQuoteFile(blob,name) {
  const url=URL.createObjectURL(blob);
  const link=document.createElement('a');
  link.href=url;
  link.download=name;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function downloadQuote(row,format) {
  const company=db.empresas.find(entry=>entry.id===row.empresa_id);
  const name='cotacao-'+row.id.slice(0,8);
  if (format==='xml') {
    const tag=(key,value)=>'<'+key+'>'+escape(value)+'</'+key+'>';
    const itemTags=row.itens.map(item=>'<item>'+['codigo','descricao','marca','unidade','quantidade'].map(key=>tag(key,item[key])).join('')+tag('preco_unitario','')+'</item>').join('');
    const xml='<?xml version="1.0" encoding="UTF-8"?><cotacao>'+tag('referencia',name)+tag('titulo',row.titulo)+tag('empresa',company?.nome)+tag('cnpj',company?.cnpj)+tag('fornecedor',row.fornecedor)+tag('instrucoes',row.observacao)+'<itens>'+itemTags+'</itens></cotacao>';
    saveQuoteFile(new Blob([xml],{type:'application/xml;charset=utf-8'}),name+'.xml');
    return;
  }
  const Pdf=await proposalPdfLibrary();
  const pdf=new Pdf({unit:'mm',format:'a4'});
  let y=placeCompanyLogo(company,pdf,18);
  function write(value,size=10,bold=false) {
    pdf.setFont('helvetica',bold?'bold':'normal');
    pdf.setFontSize(size);
    for (const text of pdf.splitTextToSize(String(value??''),178)) {
      if (y>277) { pdf.addPage();y=18; }
      pdf.text(text,16,y);
      y+=size*.46;
    }
  }
  write('SOLICITAÇÃO DE COTAÇÃO DE PREÇOS',15,true);
  write(row.titulo,12,true);
  write('Referência: '+name);
  write('Solicitante: '+(company?.nome??'')+' · CNPJ '+(company?.cnpj??''));
  for(const [key,label] of proposalIdentity.slice(0,5)) {
    const value=company?.dados_proposta?.[key];
    if(value) write(label+': '+value);
  }
  write('Fornecedor: '+row.fornecedor);
  if (row.observacao) write(row.observacao);
  for (const item of row.itens) {
    if (y>258) { pdf.addPage();y=18; }
    y+=4;
    write(item.codigo+' · '+item.descricao,10,true);
    write('Quantidade: '+decimal.format(item.quantidade)+' '+item.unidade+(item.marca?' · Marca: '+item.marca:''));
    write('Preço unitário: R$ ____________________');
  }
  pdf.save(name+'.pdf');
}

function financialPrice(item) {
  const base=Number(item.custo)+Number(item.imposto_compra_unitario ?? 0);
  const rate=(Number(item.margem)+Number(item.imposto_venda_pct ?? 0))/100;
  if (rate>=1 || !Number.isFinite(base+rate)) return null;
  const calculated=roundPrice(base/(1-rate));
  return {base,calculated,final:item.preco_venda_manual==null?calculated:Number(item.preco_venda_manual)};
}

function editFinancialPrice(item) {
  const keys=['custo','imposto_compra_unitario','imposto_venda_pct','margem','preco_venda_manual'];
  edit('Ajustar preço · '+item.codigo,[
    ['custo','Custo unitário sem os impostos adicionais (R$)','number',item.custo],
    ['imposto_compra_unitario','Imposto da compra ainda fora do custo, por unidade (R$)','number',item.imposto_compra_unitario ?? 0],
    ['imposto_venda_pct','Impostos sobre o preço de venda (%)','number',item.imposto_venda_pct ?? 0],
    ['margem','Margem desejada sobre a venda (%)','number',item.margem],
    ['preco_venda_manual','Preço de venda manual (R$)','number',item.preco_venda_manual]
  ],async values=>{
    const fields=Object.fromEntries(keys.map(key=>[key,key==='preco_venda_manual' && values[key]===''?null:Number(values[key])]));
    for (const key of keys) {
      const value=fields[key];
      if (value!==null && (!Number.isFinite(value) || value<0 || value>=1e10)) throw new Error('Confira os valores informados.');
    }
    if (fields.margem+fields.imposto_venda_pct>=100) throw new Error('A soma da margem e dos impostos sobre a venda deve ser menor que 100%.');
    if (!client) return save('catalogo',fields,item.id);
    let request=client.from('catalogo').update(fields).match({id:item.id,grupo_id:group});
    for (const key of keys) request=item[key]==null?request.is(key,null):request.eq(key,item[key]);
    const {data,error}=await request.select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('O item foi alterado. Reabra o Financeiro para conferir os dados atualizados.');
    await load();
  },{decorate:form=>{
    form.elements.namedItem('preco_venda_manual').required=false;
    const preview=document.createElement('p');
    preview.setAttribute('role','status');
    form.prepend(item.descricao);
    form.lastElementChild.before(preview);
    function update() {
      const values=Object.fromEntries(new FormData(form));
      if (values.preco_venda_manual==='') values.preco_venda_manual=null;
      const result=financialPrice(values);
      preview.textContent=result?'Custo com imposto da compra '+money.format(result.base)+' · Preço calculado '+money.format(result.calculated)+' · Preço de venda '+money.format(result.final):'A soma da margem e dos impostos sobre a venda deve ser menor que 100%.';
    }
    form.addEventListener('input',update);
    update();
  }});
}

function renderFinancialPrices(view) {
  const section=panel(view,'<h2>Formação de preço por item</h2><label>Buscar produto ou serviço<input type="search" placeholder="Código ou descrição"></label>');
  const search=section.querySelector('input');
  const table=quoteTable(section,['Produto ou serviço','Custo base','Imposto na compra','Impostos na venda','Margem','Preço calculado','Preço de venda','Ação']);
  const draw=()=>{
    table.replaceChildren();
    for (const item of db.catalogo) {
      if (!normalizeSearch(item.codigo+' '+item.descricao).includes(normalizeSearch(search.value.trim()))) continue;
      const result=financialPrice(item);
      const line=table.insertRow();
      for (const value of [item.codigo+' · '+item.descricao,money.format(item.custo),money.format(item.imposto_compra_unitario ?? 0),decimal.format(item.imposto_venda_pct ?? 0)+'%',decimal.format(item.margem)+'%',result?money.format(result.calculated):'—',result?money.format(result.final)+(item.preco_venda_manual==null?'':' · manual'):'—']) line.insertCell().textContent=value;
      const cell=line.insertCell();
      writeAction('Ajustar preço',()=>editFinancialPrice(item),cell);
    }
    if (!table.rows.length) {
      const cell=table.insertRow().insertCell();
      cell.colSpan=8;
      cell.textContent='Nenhum produto ou serviço encontrado.';
    }
  };
  search.oninput=draw;
  draw();
}

function renderQuoteFinance(view) {
  renderFinancialPrices(view);
  const section=panel(view,'<h2>Custos e preços de fornecedores</h2><p>Compare o preço recebido com o custo do catálogo antes de aplicar.</p>');
  const received=db.cotacoes.filter(row=>!isBudget(row) && row.etapa===2).flatMap(row=>row.itens.filter(item=>item.preco!=null).map(item=>({row,item})));
  if (!received.length) { section.append('Nenhum preço recebido registrado em cotações enviadas.'); return; }
  const table=quoteTable(section,['Cotação e fornecedor','Produto ou serviço','Custo atual','Preço recebido','Diferença','Ação']);
  for (const {row,item} of received) {
    const source=db.catalogo.find(entry=>entry.id===item.catalogo_id);
    const line=table.insertRow();
    for (const value of [row.titulo+' · '+row.fornecedor,item.codigo+' · '+item.descricao,source?money.format(source.custo):'Indisponível',money.format(item.preco),source?money.format(item.preco-source.custo):'—']) line.insertCell().textContent=value;
    const controls=line.insertCell();
    if (item.aplicado_em) { controls.textContent='Aplicado em '+quoteDate.format(new Date(item.aplicado_em)); continue; }
    if (!source || !client) continue;
    writeAction('Aplicar ao catálogo',()=>edit('Aplicar custo de '+item.codigo,[],async()=>{
      const {error}=await client.rpc('aplicar_custo_cotado',{p_cotacao:row.id,p_item:item.catalogo_id,p_custo_esperado:source.custo,p_revisao:row.revisao});
      if (error) throw error;
      await load();
    },{decorate:form=>{
      const summary=document.createElement('p');
      summary.textContent=item.descricao+' · '+money.format(source.custo)+' → '+money.format(item.preco);
      form.prepend(summary);
    }}),controls);
  }
}

const disputeStages=['Aguardando disputa','Em disputa','Enviado para acompanhamento'];
const disputeResults=['Sem resultado','Estamos liderando','Concorrente liderando','Ganhamos','Perdemos','Sem vencedor'];
const disputeFinal=s=>disputeResults.slice(3).includes(s);
const unitCost=item=>Number(item.custo_embalagem)/Number(item.embalagem);
const bidFloor=(cost,margin)=>Math.ceil((cost/(1-margin/100)-1e-12)*precision)/precision;
const suggestedBid=(item,margin)=>Math.min(price(item),roundPrice(unitCost(item)/(1-margin/100)));
const bidMargin=(cost,bid)=>bid>0?(1-cost/bid)*100:null;
const disputeItems=row=>db.itens.filter(item=>item.edital_id===row.id);

async function saveDispute(row,record,values) {
  if (!record.id) return save('disputas',{edital_id:row.id,...values});
  const {data,error}=await client.from('disputas').update(values).match({grupo_id:group,id:record.id,revisao:record.revisao}).select('id').maybeSingle();
  if(error) throw error;
  if(!data) throw new Error('A disputa mudou em outra sessão. Atualize a tela e tente novamente.');
  await load();
}

async function moveDispute(row,record,destination) {
  if(Math.abs(record.etapa-destination)!==1) throw new Error('Mova a disputa uma coluna por vez.');
  if(destination===2 && (!disputeItems(row).length || disputeItems(row).some(item=>!disputeFinal(record.resultados[item.id]?.situacao)))) throw new Error('Registre o resultado final de todos os itens antes de enviar.');
  if(!record.id) {
    await saveDispute(row,record,{});
    record=db.disputas.find(entry=>entry.edital_id===row.id);
  }
  await saveDispute(row,record,{etapa:destination});
}

function disputeRules(view,row,record) {
  edit('Configurar farol de margens',[
    ['margem_minima','Margem mínima sobre a venda (%)','number',record.margem_minima],
    ['alerta','Faixa amarela acima da mínima (pontos percentuais)','number',record.alerta]
  ],async values=>{
    const margem_minima=Number(values.margem_minima),alerta=Number(values.alerta);
    if(!Number.isFinite(margem_minima+alerta)||margem_minima<0||alerta<0||margem_minima+alerta>=100) throw new Error('A margem mínima e a faixa de alerta devem somar menos de 100%.');
    await saveDispute(row,record,{margem_minima,alerta});
  },{onSaved:()=>openDispute(view,row)});
}

function editDisputeItem(view,row,record,item) {
  const saved=record.resultados[item.id]??{};
  edit('Lance e resultado · Item '+item.codigo,[
    ['margem','Margem para simular lance (%)','number',saved.margem??item.margem],
    ['lance','Nosso lance unitário (R$)','number',saved.lance],
    ['concorrente','Concorrente líder','text',saved.concorrente],
    ['lance_concorrente','Melhor lance concorrente (R$)','number',saved.lance_concorrente],
    ['situacao','Situação do item','select',saved.situacao??disputeResults[0],disputeResults],
    ['vencedor','Vencedor, se for outra empresa','text',saved.vencedor],
    ['marca_vencedora','Marca vencedora','text',saved.marca_vencedora],
    ['preco_final','Preço vencedor unitário (R$)','number',saved.preco_final],
    ['observacao','Justificativa ou observação','textarea',saved.observacao]
  ],async values=>{
    const result={...values,margem:Number(values.margem)};
    if(!Number.isFinite(result.margem)||result.margem<0||result.margem>=100) throw new Error('Informe uma margem de 0 a menos de 100%.');
    if(!disputeResults.includes(result.situacao)) throw new Error('Informe uma situação válida.');
    for(const key of ['lance','lance_concorrente','preco_final']) {
      result[key]=values[key]===''?null:Number(values[key]);
      if(result[key]!==null && (!Number.isFinite(result[key])||result[key]<=0)) throw new Error('Informe valores unitários maiores que zero.');
    }
    if(['Ganhamos','Perdemos'].includes(result.situacao) && result.preco_final==null) throw new Error('Informe o preço vencedor.');
    if(result.situacao==='Perdemos' && !result.vencedor.trim()) throw new Error('Informe o nome do vencedor.');
    await saveDispute(row,record,{resultados:{...record.resultados,[item.id]:result}});
  },{onSaved:()=>openDispute(view,row),decorate:form=>{
    for(const key of ['lance','concorrente','lance_concorrente','vencedor','marca_vencedora','preco_final']) form.elements.namedItem(key).required=false;
    const preview=document.createElement('p');
    preview.setAttribute('role','status');
    form.lastElementChild.before(preview);
    const update=()=>{
      const fields=form.elements;
      const margin=Number(fields.namedItem('margem').value);
      const lance=Number(fields.namedItem('lance').value);
      preview.textContent=margin>=0 && margin<100?'Piso '+money.format(bidFloor(unitCost(item),record.margem_minima))+' · Lance pela margem '+money.format(suggestedBid(item,margin))+(lance>0?' · Margem do lance '+decimal.format(bidMargin(unitCost(item),lance))+'%':''):'Informe uma margem menor que 100%.';
    };
    form.addEventListener('input',update);
    update();
  }});
}

function openDispute(view,row) {
  const record=db.disputas.find(entry=>entry.edital_id===row.id)??{etapa:0,margem_minima:20,alerta:3,resultados:{},historico:[]};
  view.replaceChildren();
  const section=panel(view,'<h2>'+escape(row.numero)+' · '+escape(row.orgao)+'</h2><p>'+disputeStages[record.etapa]+'</p>');
  action('Voltar ao quadro',render,section);
  if(page==='disputa' && client) {
    if(record.etapa<2) writeAction('Configurar farol',()=>disputeRules(view,row,record),section);
    if(record.etapa===0) writeAction('Iniciar disputa',async()=>{await moveDispute(row,record,1);openDispute(view,row);},section,true);
    if(record.etapa===1) writeAction('Enviar para acompanhamento',async()=>{await moveDispute(row,record,2);openDispute(view,row);},section,true);
    if(record.etapa===2 && !getFollow(row)) writeAction('Reabrir disputa',async()=>{await moveDispute(row,record,1);openDispute(view,row);},section);
  }
  section.insertAdjacentHTML('beforeend','<p>Margem mínima '+decimal.format(record.margem_minima)+'% · Amarelo até '+decimal.format(Number(record.margem_minima)+Number(record.alerta))+'% · Verde acima dessa faixa · Vermelho abaixo da mínima</p>');
  const items=disputeItems(row);
  let won=0,wonTotal=0;
  for(const [lot,grouped] of groupProposalItems(items)) {
    if(lot) {
      const floor=grouped.reduce((sum,item)=>sum+bidFloor(unitCost(item),record.margem_minima)*item.quantidade,0);
      section.insertAdjacentHTML('beforeend','<h3>Lote '+escape(lot)+' · Piso total '+money.format(floor)+'</h3>');
    }
    const table=quoteTable(section,['Item','Descrição','Qtd.','Custo unit.','Proposta inicial','Margem inicial (%)','Piso unit.','Margem para simulação (%)','Lance sugerido','Farol da margem','Nosso lance','Liderança','Resultado','Fornecedor vencedor','Preço vencedor','Total vencedor','Diferença para nosso lance (R$)','Diferença para nosso lance (%)','Nossa margem no preço vencedor','Auditoria','Ação']);
    table.closest('table').classList.add('dispute-table');
    for(const item of grouped) {
      const result=record.resultados[item.id]??{};
      const cost=unitCost(item);
      const floor=bidFloor(cost,record.margem_minima);
      const initialMargin=Number(item.margem);
      const simulationMargin=result.margem??initialMargin;
      const final=result.preco_final==null?null:roundPrice(result.preco_final*item.quantidade);
      const audit=result.situacao==='Ganhamos'&&result.preco_final<floor?'Ganho abaixo do mínimo':result.situacao==='Perdemos'&&result.preco_final>=floor?'Perdido acima do mínimo':'—';
      if(result.situacao==='Ganhamos') {won++;wonTotal+=final??0;}
      const leader=result.situacao==='Estamos liderando'?'Nossa empresa':[result.concorrente,result.lance_concorrente==null?'':money.format(result.lance_concorrente)].filter(Boolean).join(' · ');
      const company=db.empresas.find(e=>e.id===row.empresa_id)?.nome||'Nossa empresa';
      const tr=table.insertRow();
      tr.insertCell().textContent=item.codigo;
      const description=tr.insertCell();
      const summary=document.createElement('span');
      summary.className='dispute-description';
      summary.textContent=printedDescription(item);
      summary.title=summary.textContent;
      description.append(summary);
      for(const value of [decimal.format(item.quantidade),money.format(cost),money.format(price(item)),decimal.format(initialMargin)+'%',money.format(floor)]) tr.insertCell().textContent=value;
      const marginCell=tr.insertCell();
      const suggestion=tr.insertCell();
      const signal=tr.insertCell();
      const ourBidCell=tr.insertCell();
      tr.insertCell().textContent=leader||'—';
      const outcome=tr.insertCell();
      const winner=tr.insertCell();
      const finalPrice=tr.insertCell();
      const finalTotal=tr.insertCell();
      const differenceCash=tr.insertCell();
      const differenceRate=tr.insertCell();
      const winnerMargin=tr.insertCell();
      function compareWinner(amount,ourBid=Number(result.lance??0)) {
        differenceCash.textContent=amount>0 && ourBid>0?money.format(roundPrice(amount-ourBid)):'—';
        differenceRate.textContent=amount>0 && ourBid>0?decimal.format((amount-ourBid)/ourBid*100)+'%':'—';
        winnerMargin.textContent=amount>0?decimal.format(bidMargin(cost,amount))+'%':'—';
      }
      compareWinner(result.preco_final);
      const auditCell=tr.insertCell();
      auditCell.textContent=audit;
      const controls=tr.insertCell();
      controls.className='dispute-actions';
      function preview(margin) {
        const valid=margin!==null && margin>=0 && margin<100;
        const bid=valid?suggestedBid(item,margin):null;
        const effective=bidMargin(cost,bid);
        const color=effective==null?'':effective+1e-8<record.margem_minima?'Vermelho':effective<=Number(record.margem_minima)+Number(record.alerta)+1e-8?'Amarelo':'Verde';
        const capped=valid && roundPrice(cost/(1-margin/100))>price(item);
        suggestion.textContent=valid?money.format(bid)+(capped?' · limite inicial':''):'—';
        signal.textContent=color?color+' · '+decimal.format(effective)+'%':'—';
        signal.style.backgroundColor=color?{Vermelho:'#fee2e2',Amarelo:'#fef3c7',Verde:'#dcfce7'}[color]:'';
      }
      preview(Number(simulationMargin));
      finalTotal.textContent=final==null?'—':money.format(final);
      if(page!=='disputa' || record.etapa!==1 || !canWrite()) {
        marginCell.textContent=decimal.format(simulationMargin);
        ourBidCell.textContent=result.lance==null?'—':money.format(result.lance)+' · '+decimal.format(bidMargin(cost,result.lance))+'%';
        outcome.textContent=result.situacao||'Sem resultado';
        winner.textContent=result.situacao==='Ganhamos'?company:result.vencedor||'—';
        finalPrice.textContent=result.preco_final==null?'—':money.format(result.preco_final);
        continue;
      }
      const makeInput=(cell,label,type,value)=>{
        const input=document.createElement('input');
        input.type=type;
        input.value=value??'';
        input.setAttribute('aria-label',label+' do item '+item.codigo);
        input.style.minWidth=type==='number'?'88px':'145px';
        if(type==='number') {input.step='0.0001';input.min='0';}
        cell.append(input);
        return input;
      };
      const margin=makeInput(marginCell,'Margem','number',simulationMargin);
      const ourBid=makeInput(ourBidCell,'Nosso lance final','number',result.lance);
      const status=document.createElement('select');
      status.setAttribute('aria-label','Resultado do item '+item.codigo);
      status.style.minWidth='144px';
      for(const entry of disputeResults) status.add(new Option(entry,entry));
      status.value=result.situacao??disputeResults[0];
      outcome.append(status);
      const supplier=makeInput(winner,'Fornecedor vencedor','text',result.vencedor);
      const amount=makeInput(finalPrice,'Preço vencedor','number',result.preco_final);
      let externalWinner=result.vencedor??'';
      function updateOutcome() {
        const own=status.value==='Ganhamos';
        supplier.disabled=status.value!=='Perdemos';
        supplier.value=own?company:status.value==='Perdemos'?externalWinner:'';
        const number=Number(amount.value);
        finalTotal.textContent=number>0?money.format(roundPrice(number*item.quantidade)):'—';
        compareWinner(number,Number(ourBid.value));
      }
      supplier.oninput=()=>{externalWinner=supplier.value;};
      status.onchange=updateOutcome;
      amount.oninput=updateOutcome;
      ourBid.oninput=updateOutcome;
      margin.oninput=()=>preview(margin.value===''?null:Number(margin.value));
      updateOutcome();
      const saveLine=action('Salvar item',async()=>{
        const value=Number(margin.value);
        const preco_final=amount.value===''?null:Number(amount.value);
        const lance=ourBid.value===''?null:Number(ourBid.value);
        if(lance!==null && (!ourBid.checkValidity() || lance<=0)) throw new Error('Informe nosso lance final maior que zero.');
        if(margin.value==='' || !margin.checkValidity() || value>=100) throw new Error('Informe uma margem de 0 a menos de 100%, com até quatro casas decimais.');
        if((preco_final!==null && (!amount.checkValidity() || preco_final<=0)) || (['Ganhamos','Perdemos'].includes(status.value) && preco_final==null)) throw new Error('Informe o preço vencedor maior que zero.');
        if(status.value==='Perdemos' && !supplier.value.trim()) throw new Error('Informe o fornecedor vencedor.');
        saveLine.disabled=true;
        try {
          const latest=db.disputas.find(entry=>entry.id===record.id);
          await saveDispute(row,latest,{resultados:{...latest.resultados,[item.id]:{...latest.resultados[item.id],margem:value,lance,situacao:status.value,
            vencedor:status.value==='Perdemos'?supplier.value.trim():'',preco_final}}});
          openDispute(view,row);
        } finally {saveLine.disabled=false;}
      },controls);
      action('Outros dados do lance',()=>editDisputeItem(view,row,record,item),controls);
    }
  }
  section.insertAdjacentHTML('beforeend','<p><strong>Itens ganhos: '+won+' · Total ganho: '+money.format(wonTotal)+'</strong></p>');
  if(record.historico.length) {
    const history=panel(view,'<h3>Histórico de movimentações</h3>');
    const list=document.createElement('ul');
    list.style.cssText='font-size:9pt;margin:4px 0';
    for(const entry of [...record.historico].reverse()) {
      const li=document.createElement('li');
      li.textContent=disputeStages[entry.origem]+' → '+disputeStages[entry.destino]+' · '+entry.usuario+' · '+quoteDate.format(new Date(entry.data));
      list.append(li);
    }
    history.append(list);
  }
}

const followTypes=['Ata','Documento do processo','Proposta assinada','Contrato','ARP'];
const followStages=['Em acompanhamento','Processo finalizado'];
const getFollow=row=>db.acompanhamentos.find(entry=>entry.edital_id===row.id);
const followResults=(row,record,dispute)=>disputeItems(row).map(item=>({
  item,result:{...dispute.resultados[item.id],...record?.ajustes[item.id]}
}));

async function ensureFollow(row) {
  const current=getFollow(row);
  if(current) return current;
  const {error}=await client.from('acompanhamentos').insert({grupo_id:group,edital_id:row.id});
  if(error && error.code!=='23505') throw error;
  await load();
  return getFollow(row);
}

function followEditor(view,row,record,item,result) {
  const previousPrice=result.preco_final;
  edit('Negociação · item '+item.codigo,[
    ['situacao','Resultado atualizado','select',result.situacao??'Sem vencedor',['Ganhamos','Perdemos','Sem vencedor']],
    ['vencedor','Novo vencedor, se for outra empresa','text',result.vencedor],
    ['preco','Preço unitário negociado (R$)','number',previousPrice],
    ['observacao','Observação da negociação','textarea',result.observacao]
  ],async values=>{
    const price=values.preco===''?null:Number(values.preco);
    const winner=values.vencedor.trim();
    if(values.situacao!=='Sem vencedor' && (price===null || !Number.isFinite(price) || price<=0)) throw new Error('Informe o preço negociado.');
    if(values.situacao==='Perdemos' && !winner) throw new Error('Informe o nome do novo vencedor.');
    const current=record??await ensureFollow(row);
    const ajuste={situacao:values.situacao,vencedor:values.situacao==='Perdemos'?winner:'',preco_final:values.situacao==='Sem vencedor'?null:roundPrice(price),observacao:values.observacao.trim()};
    await updateFollow(current,{ajustes:{...current.ajustes,[item.id]:ajuste}});
  },{onSaved:()=>openFollow(view,row),decorate:form=>{
    const fields=form.elements;
    const price=fields.namedItem('preco');
    price.required=false;
    price.step='0.0001';
    fields.namedItem('vencedor').required=false;
    const margin=document.createElement('input');
    margin.type='number';
    margin.step='0.0001';
    margin.max='99.9999';
    const label=document.createElement('label');
    label.append('Margem negociada sobre a venda (%)',margin);
    const totalPreview=document.createElement('p');
    totalPreview.setAttribute('role','status');
    form.lastElementChild.before(label,totalPreview);
    const refresh=()=>{
      const actual=bidMargin(unitCost(item),Number(price.value));
      totalPreview.textContent=actual==null?'Informe o preço ou a margem.':'Total do item '+money.format(roundPrice(Number(price.value)*item.quantidade))+' · Margem efetiva '+decimal.format(actual)+'%';
    };
    const sync=()=>{
      const actual=bidMargin(unitCost(item),Number(price.value));
      margin.value=actual==null?'':roundPrice(actual);
      refresh();
    };
    margin.oninput=()=>{
      if(margin.value!=='' && margin.checkValidity()) price.value=roundPrice(unitCost(item)/(1-Number(margin.value)/100));
      refresh();
    };
    price.oninput=sync;
    sync();
  }});
}

async function updateFollow(record,values) {
  const {data,error}=await client.from('acompanhamentos').update(values).match({grupo_id:group,id:record.id,versao:record.versao}).select('id').maybeSingle();
  if(error) throw error;
  if(!data) throw new Error('O processo mudou em outra sessão. Atualize a tela antes de continuar.');
  await load();
}

function followAttach(view,row,record,kind='Ata',types=followTypes) {
  edit('Anexar documento do processo',[
    ['tipo','Tipo de documento','select',kind,types],
    ['nome','Nome do documento','text',''],
    ['arquivo','Arquivo PDF','file']
  ],async values=>{
    const nome=values.nome.trim();
    if(!nome) throw new Error('Dê um nome ao documento.');
    const pdf=await encodePdf(values.arquivo);
    const current=record??await ensureFollow(row);
    const {error}=await client.from('acompanhamento_arquivos').insert({
      grupo_id:group,acompanhamento_id:current.id,tipo:values.tipo,nome,pdf,versao:current.versao
    });
    if(error) throw error;
  },{onSaved:()=>openFollow(view,row)});
}

function openFollow(view,row) {
  const record=getFollow(row);
  const dispute=db.disputas.find(d=>d.edital_id===row.id && d.etapa===2);
  if(!dispute) return;
  view.replaceChildren();
  const locked=!!record?.finalizado_em;
  const section=panel(view,'<h2>'+escape(row.numero)+' · '+escape(row.orgao)+'</h2><p>'+followStages[Number(locked)]+(locked?' · '+quoteDate.format(new Date(record.finalizado_em)):'')+'</p>');
  action('Voltar aos processos',render,section);
  const items=followResults(row,record,dispute);
  const company=db.empresas.find(e=>e.id===row.empresa_id)?.nome||'Nossa empresa';
  const won=items.filter(({result})=>result.situacao==='Ganhamos');
  const ready=won.length>0 && won.every(({result})=>Number(result.preco_final)>0);
  const table=quoteTable(section,['Lote','Item','Descrição','Resultado','Vencedor','Preço unitário','Margem pelo nosso custo','Total','Ação']);
  for(const {item,result} of items) {
    const tr=table.insertRow();
    const value=result.preco_final,margin=bidMargin(unitCost(item),Number(value));
    for(const entry of [item.lote||'—',item.codigo,printedDescription(item),result.situacao||'—',result.situacao==='Ganhamos'?company:result.vencedor||'—',value==null?'—':money.format(value),margin==null?'—':decimal.format(margin)+'%',value==null?'—':money.format(roundPrice(value*item.quantidade))]) tr.insertCell().textContent=entry;
    const controls=tr.insertCell();
    if(!locked) writeAction('Editar negociação',()=>followEditor(view,row,record,item,result),controls);
  }
  if(ready) action('Baixar proposta readequada em PDF',()=>downloadProposalPdf(row,
    won.map(({item,result})=>({...item,custo_embalagem:null,preco_unitario:result.preco_final})),{readequada:true}),section,true);
  const docs=panel(view,'<h3>Documentos do processo</h3>');
  if(!locked) {
    writeAction('Anexar ata ou documento',()=>followAttach(view,row,record),docs);
    if(ready) writeAction('Anexar proposta readequada assinada',()=>followAttach(view,row,record,'Proposta assinada'),docs);
    writeAction('Anexar contrato ou ARP',()=>followAttach(view,row,record,'Contrato',['Contrato','ARP']),docs);
    if(ready) docs.insertAdjacentHTML('beforeend','<p>Assine o PDF digitalmente ou à mão, anexe a via assinada e envie pelo canal indicado pelo órgão.</p>');
  }
  if(record) loadFollowFiles(docs,record).catch(error=>message(error.message));
  if(!locked) writeAction('Enviar para Processos Finalizados',()=>edit('Finalizar processo',[],async()=>{
    const current=record??await ensureFollow(row);
    await updateFollow(current,{finalizado_em:new Date().toISOString()});
  },{onSaved:()=>{if(screenAllowed('finalizados')) page='finalizados'; render();},decorate:form=>{
    const notice=document.createElement('p');
    notice.textContent='O processo será arquivado. Se houver itens ganhos, eles entrarão na Logística com as quantidades e preços finais. Anexe o contrato ou a ata de registro de preços antes de concluir.';
    form.prepend(notice);
  }}),docs);
}

async function loadFollowFiles(section,record) {
  const {data,error}=await client.from('acompanhamento_arquivos').select('id,nome,tipo,versao,criado_em').match({grupo_id:group,acompanhamento_id:record.id}).order('criado_em',{ascending:false});
  if(error) throw error;
  if(!section.isConnected || !data.length) return;
  const table=quoteTable(section,['Nome','Tipo','Data do anexo','Ação']);
  for(const doc of data) {
    const tr=table.insertRow();
    for(const value of [doc.nome,doc.tipo+(doc.tipo==='Proposta assinada' && doc.versao!==record.versao?' · versão anterior':''),quoteDate.format(new Date(doc.criado_em))]) tr.insertCell().textContent=value;
    action('Baixar PDF',async()=>{
      const {data,error}=await client.from('acompanhamento_arquivos').select('pdf').match({grupo_id:group,id:doc.id}).single();
      if(error) throw error;
      saveQuoteFile(new Blob([pdfBytes(data.pdf)],{type:'application/pdf'}),doc.nome.replace(/\.pdf$/i,'')+'.pdf');
    },tr.insertCell());
  }
}

let logisticsContract;
function renderLogistics(view) {
  const processes=db.editais.filter(row=>getFollow(row)?.finalizado_em).map(row=>{
    const follow=getFollow(row);
    const dispute=db.disputas.find(entry=>entry.edital_id===row.id&&entry.etapa===2);
    const itens=dispute?followResults(row,follow,dispute).filter(({item,result})=>result.situacao==='Ganhamos'&&Number(item.quantidade)>0&&Number(result.preco_final)>0).map(({item,result})=>({
      id:item.id,nome:[item.codigo,printedDescription(item),item.unidade].filter(Boolean).join(' · '),quantidade:Number(item.quantidade),preco:Number(result.preco_final)
    })):[];
    return {id:row.id,label:row.numero+' · '+row.orgao,orgao:row.orgao,itens};
  });
  const initialContract=logisticsContract;
  logisticsContract=null;
  logisticsWorkspace(view,{client,group,canWrite:canWrite(),initialContract,
    panel,action,edit,escape,table:quoteTable,notice:message,processes,encodePdf,pdfBytes,saveQuoteFile});
}

function renderFollow(view) {
  if(!client || unavailableRegistries.has('acompanhamentos')) {
    panel(view,'<p>O acompanhamento depende do banco de dados conectado.</p>');
    return;
  }
  const archived=page==='finalizados';
  const rows=db.editais.filter(row=>db.disputas.some(d=>d.edital_id===row.id && d.etapa===2) && !!getFollow(row)?.finalizado_em===archived);
  const filter=archived?panel(view,'<label>Buscar pelo número do processo<input type="search"></label>').querySelector('input'):null;
  const result=document.createElement('div');
  view.append(result);
  function draw() {
  result.replaceChildren();
  const matches=filter?rows.filter(row=>row.numero.toLowerCase().includes(filter.value.trim().toLowerCase())):rows;
  if(!matches.length) panel(result,archived?'<p>Nenhum processo finalizado.</p>':'<p>Nenhum processo recebido da disputa.</p>');
  for(const row of matches) {
    const card=panel(result,'<h3>'+escape(row.numero)+'</h3><p>'+escape(row.orgao)+'</p>');
    processSummary(card,row,archived?'Arquivado em '+supportDate(getFollow(row).finalizado_em):'Próxima ação: conferir o resultado e os documentos');
    action(archived?'Consultar processo':'Abrir acompanhamento',()=>openFollow(view,row),card);
  }
  }
  if(filter) filter.oninput=draw;
  draw();
}

function renderDisputes(view) {
  if(unavailableRegistries.has('disputas')) {
    panel(view,'<p>O quadro de disputa aguarda a atualização do banco de dados.</p>');
    return;
  }
  const follow=page==='acompanhamento';
  const grid=document.createElement('section');
  grid.style.cssText=follow?'':'display:grid;grid-template-columns:repeat(3,minmax(210px,1fr));gap:12px;overflow:auto';
  const rows=db.editais.filter(row=>(row.status==='Aprovado'&&proposalStage(row)===5)||db.disputas.some(d=>d.edital_id===row.id));
  const recordFor=row=>db.disputas.find(entry=>entry.edital_id===row.id)??{etapa:0,resultados:{}};
  for(const [index,stage] of disputeStages.entries()) {
    if(follow && index!==2) continue;
    const entries=rows.filter(row=>recordFor(row).etapa===index);
    const lane=document.createElement('section');
    lane.className='lane';
    lane.innerHTML='<h3>'+stage+' · '+entries.length+'</h3>';
    if(!follow && client && canWrite()) {
      lane.ondragover=event=>event.preventDefault();
      lane.ondrop=event=>{
        event.preventDefault();
        const row=rows.find(entry=>entry.id===event.dataTransfer.getData('text/plain'));
        if(row && recordFor(row).etapa!==index) moveDispute(row,recordFor(row),index).then(render).catch(error=>message(error.message));
      };
    }
    for(const row of entries) {
      const card=panel(lane,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p>');
      card.classList.add('card');
      card.draggable=!follow && !!client && canWrite();
      card.ondragstart=event=>event.dataTransfer.setData('text/plain',row.id);
      action(follow?'Ver resultado':'Abrir disputa',()=>openDispute(view,row),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

function renderProposalBoard(view) {
  const grid = document.createElement('section');
  grid.className = 'proposal-board';
  const approved = db.editais.filter(row=>row.status==='Aprovado');
  for (const [index,stage] of proposalStages.entries()) {
    const rows = approved.filter(row=>proposalStage(row)===index);
    const lane = document.createElement('section');
    lane.className = 'lane';
    lane.innerHTML = '<h3>'+stage+' · '+rows.length+'</h3>';
    if (client && canWrite()) {
      lane.ondragover = event=>event.preventDefault();
      lane.ondrop = event=>{
        event.preventDefault();
        const row = approved.find(row=>row.id===event.dataTransfer.getData('text/plain'));
        if (row) moveProposal(row,index).catch(error=>message(error.message));
      };
    }
    for (const row of rows) {
      const card = panel(lane,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p><p>'+money.format(total(db.itens.filter(item=>item.edital_id===row.id)))+'</p>');
      processSummary(card,row,db.itens.some(item=>item.edital_id===row.id)?'Próxima ação: '+stage:'Pendência: adicionar itens');
      card.classList.add('card');
      card.draggable = Boolean(client && canWrite());
      card.ondragstart = event=>event.dataTransfer.setData('text/plain',row.id);
      action('Abrir proposta',()=>openWorkflowProposal(row),card);
    }
    grid.append(lane);
  }
  view.append(grid);
}

function openWorkflowProposal(row) {
  activeEdital = row.id;
  detailMode = 'proposal';
  render();
}

function renderReadyProposals(view) {
  const section = panel(view,'<h2>Propostas prontas para disputa</h2>');
  const rows = db.editais.filter(row=>row.status==='Aprovado' && proposalStage(row)===5);
  if (!rows.length) section.append('Nenhuma proposta nesta etapa.');
  for (const row of rows) {
    const card = panel(section,'<strong>'+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p>');
    processSummary(card,row,db.itens.filter(item=>item.edital_id===row.id).length+' itens na proposta');
    action('Conferir proposta e arquivos',()=>openWorkflowProposal(row),card);
  }
}

const iconPaths = {
  cotacoes:'M3 3h7v18H3z M14 3h7v18h-7z M5 8h3m-3 4h3m8-4h3m-3 4h3',
  orcamento:'M5 3h14v18l-3-2-4 2-4-2-3 2z M8 8h8m-8 4h5',
  propostaPronta:'M5 3h10l4 4v14H5z M9 14l2 2 5-5',
  disputa:'M5 5l14 14M4 9V4h5m6 0h5v5M5 19l14-14m-4 15h5v-5M4 15v5h5',
  acompanhamento:'M12 2v3m0 14v3M2 12h3m14 0h3M5 12a7 7 0 1014 0 7 7 0 10-14 0m7-4v4l3 2',
  finalizados:'M3 4h18v4H3z M5 8v12h14V8m-10 4h6',
  logistica:'M2 6h12v11H2z M14 10h4l4 4v3h-8m-8 0a2 2 0 104 0m6 0a2 2 0 104 0',
  financeiro:'M3 6h18v12H3z m0 4h18M7 15h3m5 0h2',
  aplicativo:'M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zm4 16h2',
  masterEmpresas:'M3 21V3h12v18m0-11h6v11M1 21h22M7 7h4m-4 4h4m-4 4h4',
  masterAcessos:'M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2M9 12a4 4 0 100-8 4 4 0 000 8zm9 0l2 2 3-4',
  masterAssinaturas:'M5 3h14v18H5z M8 8h8m-8 4h8m-8 5h4',
  masterFinanceiro:'M3 5h17v15H3z M3 8h17m-6 4h7v5h-7z',
  masterComercial:'M3 4h18v15H3z M3 6l9 7 9-7',
  masterSuporte:'M4 13v-2a8 8 0 0116 0v2M4 12H2v6h4v-6zm16 0h2v6h-4v-6zm0 6v2h-6',
  masterAparencia:'M3 4h18v16H3z M3 8h18m-12 0v12m3-8h6m-6 4h4',
  masterAuditoria:'M5 3h14v18H5z m3 5h8m-8 4h8m-8 4h4',
  masterVersoes:'M4 12a8 8 0 0114-5l2 3m0-6v6h-6m6 2a8 8 0 01-14 5l-2-3m0 6v-6h6',

  painel:'M3 10l9-7 9 7v10h-6v-6H9v6H3z', editais:'M3 4h18v16H3z M9 4v12 M15 4v9',
  propostas:'M5 3h10l4 4v14H5z M8 12h8 M8 16h8',
  documentacao:'M3 7h7l2 2h9v11H3z M9 14l2 2 4-4',
  empresas:'M3 21V9l9-6 9 6v12 M8 21v-7h8v7',
  orgaos:'M3 9l9-6 9 6z M5 10v9 M10 10v9 M14 10v9 M19 10v9 M3 21h18',
  catalogo:'M3 7l9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10',
  configuracoes:'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  relatorios:'M4 3h16v18H4z M8 17v-4 M12 17V7 M16 17v-7',
  ajuda:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0 M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4 M12 17h.01',
  equipe:'M3 21v-2a4 4 0 014-4h4a4 4 0 014 4v2 M16 15a4 4 0 014 4v2 M9 11a4 4 0 100-8 4 4 0 000 8z',
  clientes:'M12 22s8-4 8-12V5l-8-3-8 3v5c0 8 8 12 8 12z',
  sair:'M10 4H4v16h6 M8 12h13 M17 8l4 4-4 4',
  plus:'M12 5v14 M5 12h14', arrow:'M4 12h16 M15 7l5 5-5 5'
};
function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${iconPaths[name]}"/></svg>`;
}
function goTo(key) {
  if (!screenAllowed(key) || (key==='configuracoes' && !canOpenCompanySettings())) return;
  page = key;
  activeEdital = null;
  message('');
  render();
}
function navAction(key,label,run,parent) {
  const button = action(label,run,parent);
  button.insertAdjacentHTML('afterbegin',icon(iconPaths[key] ? key : 'propostas'));
  button.setAttribute('aria-current',String(key === page || (key === 'painel' && page === 'relatorios')));
}
function renderOverview(view) {
  renderUpcoming(view);
  const yearNow=new Intl.DateTimeFormat('pt-BR',{year:'numeric',timeZone:'America/Sao_Paulo'}).format(new Date());
  const yearOf=row=>row.sessao?.slice(0,4) || row.numero?.match(/(?:^|[^0-9])((?:19|20)[0-9]{2})(?![0-9])/)?.[1] || '';
  const years=[...new Set([yearNow,...db.editais.map(yearOf),...db.cotacoes.map(row=>row.criado_em?.slice(0,4))].filter(Boolean))].sort().reverse();
  const overview=document.createElement('section');
  overview.className='overview-banner';
  overview.innerHTML='<div><span class="eyebrow">OPERAÇÃO DE LICITAÇÕES</span><h2>Editais e propostas,<br>na mesma direção.</h2><p>Acompanhe oportunidades, organize a documentação e prepare suas propostas.</p><div class="hero-buttons"></div></div><div class="banner-side"></div>';
  const controls=overview.querySelector('.hero-buttons');
  const board=action('Abrir quadro de captação',()=>goTo('editais'),controls);
  board.className='accent';
  board.insertAdjacentHTML('beforeend',icon('arrow'));
  action('Ver propostas',()=>goTo('propostas'),controls).className='outline-light';
  action('Ver relatórios',()=>goTo('relatorios'),controls).className='outline-light';
  const bannerStats=overview.querySelector('.banner-side');
  view.append(overview);
  const filter=panel(view,'<label>Ano em vigor<select></select></label>');
  filter.classList.add('overview-year-filter');
  const select=filter.querySelector('select');
  for(const year of years) select.add(new Option(year,year));
  select.add(new Option('Todos os anos','todos'));
  select.add(new Option('Sem ano identificado','sem-ano'));
  select.value=yearNow;
  const filters=panel(view,'<h2>Análise de licitações</h2><div class="line"></div>');
  const filterLine=filters.querySelector('.line');
  function analysisFilter(label,options) {
    const wrapper=document.createElement('label');
    const choice=document.createElement('select');
    wrapper.append(label,choice);
    for(const [value,name] of options) choice.add(new Option(name,value));
    filterLine.append(wrapper);
    choice.onchange=draw;
    return choice;
  }
  const empresa=analysisFilter('Empresa participante',[['','Todas'],...db.empresas.map(row=>[row.id,row.nome])]);
  const modalidade=analysisFilter('Modalidade',[['','Todas'],...modalities.map(name=>[name,name])]);
  const situacao=analysisFilter('Situação',[['','Todas'],...stages.map(name=>[name,name])]);
  const dimension=analysisFilter('Agrupar por',[['status','Situação'],['modalidade','Modalidade'],['orgao','Órgão'],['mes','Mês da sessão']]);
  const measure=analysisFilter('Indicador do gráfico',[['count','Quantidade de editais'],['value','Valor em propostas']]);
  const summary=document.createElement('div');
  view.append(summary);
  function draw() {
    summary.replaceChildren();
    const selected=select.value;
    const inYear=year=>selected==='todos' || (selected==='sem-ano'?!year:year===selected);
    const editais=db.editais.filter(row=>inYear(yearOf(row))&&(!empresa.value||row.empresa_id===empresa.value)
      &&(!modalidade.value||row.modalidade===modalidade.value)&&(!situacao.value||row.status===situacao.value));
    const ids=new Set(editais.map(row=>row.id));
    const items=db.itens.filter(item=>ids.has(item.edital_id));
    const count=status=>editais.filter(row=>row.status===status).length;
    bannerStats.innerHTML=[
      ['Editais captados',count('Captado')],['Editais em análise',count('Em análise')],
      ['Editais aprovados',count('Aprovado')],['Propostas com itens',new Set(items.map(item=>item.edital_id)).size]
    ].map(([label,value])=>'<div><span>'+label+'</span><strong>'+value+'</strong></div>').join('');

    const disputes=db.disputas.filter(row=>ids.has(row.edital_id));
    const disputeIds=new Set(disputes.map(row=>row.edital_id));
    const waiting=editais.filter(row=>row.status==='Aprovado' && proposalStage(row)===5 && !disputeIds.has(row.id)).length;
    const follow=db.acompanhamentos.filter(row=>ids.has(row.edital_id));
    const followMap=new Map(follow.map(row=>[row.edital_id,row]));
    const grouped=new Map();
    for(const item of items) {
      if(!grouped.has(item.edital_id)) grouped.set(item.edital_id,[]);
      grouped.get(item.edital_id).push(item);
    }
    let won=0,lost=0,itemsWon=0,itemsLost=0,amount=0;
    for(const dispute of disputes) {
      const adjustments=followMap.get(dispute.edital_id)?.ajustes??{};
      const results=(grouped.get(dispute.edital_id)??[]).map(item=>({item,result:adjustments[item.id]??dispute.resultados[item.id]}));
      for(const {item,result} of results) {
        if(result?.situacao==='Ganhamos') {
          itemsWon++;
          if(Number(result.preco_final)>0) amount+=Math.round(Number(result.preco_final)*item.quantidade*precision);
        } else if(result?.situacao==='Perdemos') itemsLost++;
      }
      if(!results.length || !results.every(({result})=>disputeFinal(result?.situacao))) continue;
      if(results.some(({result})=>result.situacao==='Ganhamos')) won++;
      else if(results.some(({result})=>result.situacao==='Perdemos')) lost++;
    }
    const grid=document.createElement('section');
    grid.className='grid overview-metrics';
    for(const [label,value,detail,symbol] of [
      ['Disputas cadastradas',disputes.length+waiting,'Inclui propostas prontas que aguardam disputa','disputa'],
      ['Valor em propostas',money.format(total(items)),'Soma das propostas cadastradas','propostas'],
      ['Valor ganho',money.format(amount/precision),'Preço atualizado × quantidade dos itens ganhos','financeiro'],
      ['Disputas ganhas',won,'Resultado completo com pelo menos um item ganho','disputa'],
      ['Disputas perdidas',lost,'Resultado completo com perda e nenhum item ganho','disputa'],
      ['Itens ganhos',itemsWon,'Resultado registrado como Ganhamos','propostas'],
      ['Itens perdidos',itemsLost,'Resultado registrado como Perdemos','propostas']
    ]) grid.insertAdjacentHTML('beforeend','<div class="metric"><div><span>'+label+'</span><span class="metric-icon">'+icon(symbol)+'</span></div><strong>'+escape(value)+'</strong><small>'+detail+'</small></div>');
    summary.append(grid);
    const chart=panel(summary,'<h2>Distribuição dos resultados</h2>');
    const values=new Map();
    for(const row of editais) {
      const key=(dimension.value==='mes'?row.sessao?.slice(0,7):row[dimension.value])||'Não informado';
      const amount=measure.value==='count'?1:total(grouped.get(row.id)??[]);
      values.set(key,(values.get(key)??0)+amount);
    }
    if(!values.size) chart.append('Nenhum edital corresponde aos filtros.');
    else {
      const data=[...values].sort((a,b)=>b[1]-a[1]);
      const max=Math.max(1,data[0][1]);
      const chartTable=quoteTable(chart,['Grupo','Indicador','Valor']);
      for(const [label,value] of data) {
        const row=chartTable.insertRow();
        row.insertCell().textContent=label;
        const meter=document.createElement('meter');
        meter.min=0;meter.max=max;meter.value=value;meter.setAttribute('aria-label',label);
        meter.style.width='100%';
        row.insertCell().append(meter);
        row.insertCell().textContent=measure.value==='count'?decimal.format(value):money.format(value);
      }
    }
    const section=panel(summary,'<h2>Resumo por tela</h2>');
    const table=quoteTable(section,['Tela','Indicadores','Acesso']);
    const byStage=(rows,names)=>names.map((name,index)=>name+' '+rows.filter(row=>row.etapa===index).length).join(' · ');
    const quotes=db.cotacoes.filter(row=>inYear(row.criado_em?.slice(0,4)));
    const proposals=editais.filter(row=>row.status==='Aprovado' || grouped.has(row.id));
    const finalized=follow.filter(row=>row.finalizado_em).length;
    const modules=[
      ['editais',stages.map(status=>status+' '+editais.filter(row=>row.status===status).length).join(' · ')],
      ['propostas',byStage(proposals.map(row=>({etapa:proposalStage(row)})),proposalStages)],
      ['disputa',byStage([...disputes,...Array.from({length:waiting},()=>({etapa:0}))],disputeStages)],
      ['acompanhamento',(disputes.filter(row=>row.etapa===2).length-finalized)+' processos em acompanhamento'],
      ['finalizados',finalized+' processos arquivados'],
      ['cotacoes',byStage(quotes.filter(row=>!isBudget(row)),quoteStages)],
      ['orcamento',byStage(quotes.filter(isBudget),budgetStages)],
      ['orgaos',db.orgaos_compradores.length+' órgãos e clientes cadastrados · total do cadastro'],
      ['catalogo',db.catalogo.length+' produtos e serviços cadastrados · total do cadastro'],
      ['financeiro',quotes.filter(row=>!isBudget(row)&&row.etapa===2).flatMap(row=>row.itens).filter(item=>item.preco!=null&&!item.aplicado_em).length+' preços recebidos aguardando aplicação']
    ];
    for(const [route,detail] of modules) {
      const row=table.insertRow();
      row.insertCell().textContent=screens[route];
      row.insertCell().textContent=detail;
      action('Abrir '+screens[route],()=>goTo(route),row.insertCell());
    }
  }
  select.onchange=draw;
  draw();
}

function renderReports(view) {
  const report = panel(view,'<h2>Editais por data da sessão</h2><form class="line"><label>De<input name="from" type="date"></label><label>Até<input name="to" type="date"></label><label>Situação<select name="status"></select></label><button type="submit" class="primary">Filtrar</button></form><p role="alert"></p><div class="scroll"></div>');
  const form = report.querySelector('form');
  const status = form.elements.namedItem('status');
  status.add(new Option('Todas',''));
  stages.forEach(stage => status.add(new Option(stage)));
  const results = report.querySelector('.scroll');
  const alert = report.querySelector('[role=alert]');
  const totals = new Map();
  for (const item of db.itens) {
    totals.set(item.edital_id,(totals.get(item.edital_id) ?? 0) + Math.round(price(item)*item.quantidade*precision));
  }
  function draw() {
    const {from,to,status} = Object.fromEntries(new FormData(form));
    if (from && to && from > to) {
      alert.textContent = 'A data inicial deve ser anterior ou igual à final.';
      results.replaceChildren();
      return;
    }
    alert.textContent = '';
    const rows = db.editais.filter(row => (!status || row.status === status)
      && (!from || (row.sessao && row.sessao >= from))
      && (!to || (row.sessao && row.sessao <= to)));
    const value = rows.reduce((sum,row) => sum + (totals.get(row.id) ?? 0),0);
    results.innerHTML = `<p><strong>${rows.length}</strong> edital(is) · <strong>${money.format(value/precision)}</strong> em propostas</p>`;
    if (!rows.length) {
      results.insertAdjacentHTML('beforeend','<p>Nenhum edital encontrado.</p>');
      return;
    }
    results.insertAdjacentHTML('beforeend',`<table><thead><tr><th>Processo</th><th>Órgão</th><th>Sessão</th><th>Situação</th><th>Valor da proposta</th></tr></thead><tbody>${rows.map(row => {
      const date = row.sessao ? row.sessao.split('-').reverse().join('/') : 'A definir';
      return '<tr>'+[row.numero,row.orgao,date,row.status,totals.has(row.id) ? money.format(totals.get(row.id)/precision) : '—'].map(value=>'<td>'+escape(value)+'</td>').join('')+'</tr>';
    }).join('')}</tbody></table>`);
  }
  form.onsubmit = event => { event.preventDefault(); draw(); };
  draw();
}

function renderHelp(view) {
  const articles = [
    ['configuracoes','Onde cadastrar o CNPJ participante?','Em Configurações, abra CNPJs participantes e informe a razão social, o CNPJ e o enquadramento.'],
    ['editais','Como aprovar uma oportunidade?','Abra a oportunidade em Captação, selecione o CNPJ participante e registre o parecer da equipe.'],
    ['propostas','Como montar a proposta?','Abra um edital aprovado em Propostas e informe os itens, as quantidades, os custos e as margens.'],
    ['documentacao','Como conferir os documentos?','Abra o checklist do edital em Documentação, registre as validades e marque os requisitos conferidos.'],
    ['relatorios','Como acompanhar valores e prazos?','Em Relatórios, filtre os editais pela data da sessão e pela situação.']
  ];
  const section = panel(view,'<label>Buscar no manual<input type="search" placeholder="Ex.: CNPJ ou proposta"></label><p role="status"></p><div></div>');
  const search = section.querySelector('input');
  const results = section.lastElementChild;
  const status = section.querySelector('[role=status]');
  const normalize = value => value.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
  function draw() {
    const query = normalize(search.value.trim());
    const matches = articles.filter(([,title,body]) => normalize(title+' '+body).includes(query));
    results.replaceChildren();
    status.textContent = matches.length ? '' : 'Nenhuma orientação encontrada.';
    for (const [route,title,body] of matches) {
      const detail = document.createElement('details');
      detail.className = 'card';
      detail.innerHTML = `<summary>${title}</summary><p>${body}</p>`;
      action('Abrir '+(screens[route] ?? 'Relatórios'),()=>goTo(route),detail);
      results.append(detail);
    }
  }
  search.oninput = draw;
  draw();
}

function applyScreenAppearance(view) {
  const settings=screenAppearance.find(entry=>entry.tela===page)?.ajustes;
  const content=view.closest('main');
  for(const key of ['font','align','size','title','padding','width']) content.style.removeProperty('--page-'+key);
  if(!settings) return;
  const allowedFonts=['inherit','system-ui','Georgia, serif','monospace'];
  if(allowedFonts.includes(settings.font)) content.style.setProperty('--page-font',settings.font);
  if(['left','center','right'].includes(settings.align)) content.style.setProperty('--page-align',settings.align);
  for(const [key,min,max,unit] of [['size',12,22,'px'],['title',16,40,'px'],['padding',8,40,'px'],['width',35,100,'%']]) {
    const value=Number(settings[key]);
    if(Number.isFinite(value)&&value>=min&&value<=max) content.style.setProperty('--page-'+key,value+unit);
  }
}

let previousScreen;


const reportThemeChoices=[['azul','Azul institucional'],['verde','Verde petróleo'],['vinho','Vinho']];
const reportYesNo=[['sim','Sim'],['nao','Não']];
function reportSettingsKey() {return 'relatorios:'+JSON.stringify([session?.user?.id??'local',master?'mestre':group??'local']);}
function reportSettings() {
  try {return {...reportDefaults,...JSON.parse(localStorage.getItem(reportSettingsKey())??'{}')};}
  catch {return {...reportDefaults};}
}
function renderReportSettings(view) {
  const card=panel(view,'<h2>Preferências do PDF executivo</h2><p>Os padrões são salvos neste navegador para seu usuário e podem ser ajustados a cada exportação.</p>');
  const prefs=reportSettings();
  const theme=reportThemeChoices.find(([key])=>key===prefs.tema)?.[1]??'Azul institucional';
  panel(card,'<p>Tema: '+escape(theme)+' · Gráfico inicial: '+(prefs.graficos==='sim'?'Sim':'Não')+' · Tabelas: '+(prefs.detalhes==='sim'?'Sim':'Não')+'</p>');
  action('Editar preferências',()=>edit('Configurações de relatórios',[
    ['tema','Paleta de cores','select',prefs.tema,reportThemeChoices],
    ['graficos','Incluir um gráfico inicial quando houver dados','select',prefs.graficos,reportYesNo],
    ['detalhes','Incluir tabelas detalhadas no PDF','select',prefs.detalhes,reportYesNo]
  ],values=>localStorage.setItem(reportSettingsKey(),JSON.stringify(values))),card,true);
}
function mountScreenReport(view) {
  const controls=byId('page-actions');
  const title=byId('page-title').textContent;
  action('Exportar relatório',()=>{
    const report=collectReport(view);
    if(!report.tables.length&&!report.notes.length) {message('A tela ainda não tem dados para exportar.');return;}
    const prefs=reportSettings();
    const companies=master?[]:db.empresas;
    const linkedCompany=db.editais.find(row=>row.id===activeEdital)?.empresa_id;
    const defaultCompany=companies.find(row=>row.id===linkedCompany)?.id??(companies.length===1?companies[0].id:'grupo');
    let chartControls;
    edit('Preparar relatório para a diretoria',[
      ['formato','Formato','select','pdf',[['pdf','PDF executivo'],['csv','CSV para análise']]],
      ['titulo','Título do relatório','text',title],
      ...(companies.length?[['empresa_relatorio','Empresa no cabeçalho','select',defaultCompany,[['grupo','Identificação do espaço de trabalho'],...companies.map(row=>[row.id,row.nome+' · '+row.cnpj])]]]:[]),
      ['resumo','Resumo executivo e próximos passos','textarea',''],
      ['tema','Paleta de cores','select',prefs.tema,reportThemeChoices],
      ['detalhes','Incluir tabelas no PDF','select',prefs.detalhes,reportYesNo]
    ],async values=>{
      const file='relatorio-'+values.titulo.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/-$/,'');
      if(values.formato==='csv') {
        const rows=report.tables.length?report.tables.flatMap((t,i)=>[...(i?[[]]:[]),t.headers,...t.rows]):report.notes.map(note=>[note]);
        const safe=cell=>'"'+(/^[\s]*[=+@-]/.test(cell)?"'":'')+cell.replaceAll('"','""')+'"';
        const csv=rows.map(row=>row.map(safe).join(';')).join(String.fromCharCode(13,10));
        saveQuoteFile(new Blob([String.fromCharCode(65279),csv],{type:'text/csv;charset=utf-8'}),file+'.csv');
        return;
      }
      const charts=[...chartControls.querySelectorAll('fieldset')].map(field=>{
        const [source,label,metric]=field.querySelectorAll('select');
        const table=report.tables[Number(source.value)];
        const rows=chartData(table,Number(label.value),metric.value);
        const metricLabel=metric.value==='count'?'Quantidade':table.headers[Number(metric.value)];
        return {title:metricLabel+' por '+table.headers[Number(label.value)],rows};
      });
      const Pdf=await proposalPdfLibrary();
      const pdf=new Pdf({unit:'mm',format:'a4'});
      const issuer=master?'Mestre Gerenciador':groups.find(row=>row.id===group)?.nome;
      const company=companies.find(row=>row.id===values.empresa_relatorio);
      renderExecutivePdf(pdf,{title:values.titulo,issuer,company:reportCompanyIdentity(company),date:new Date().toLocaleDateString('pt-BR'),
        summary:values.resumo.trim(),theme:values.tema,details:values.detalhes==='sim',report,charts});
      pdf.save(file+'.pdf');
    },{onSaved:()=>{},decorate:form=>{
      form.elements.resumo.required=false;
      const section=document.createElement('section');
      const heading=document.createElement('h3');heading.textContent='Gráficos do PDF';section.append(heading);
      chartControls=document.createElement('div');section.append(chartControls);
      form.lastElementChild.before(section);
      if(!report.tables.length) {section.append('A tela precisa ter uma tabela com dados para montar gráficos.');return;}
      const add=action('Adicionar gráfico',addChart,section);
      if(prefs.graficos==='sim') addChart();
      form.elements.formato.onchange=()=>{section.hidden=form.elements.formato.value!=='pdf';};
      function addChart() {
        if(chartControls.children.length>=6)return;
        const field=document.createElement('fieldset');
        const legend=document.createElement('legend');legend.textContent='Gráfico';field.append(legend);
        function select(label) {
          const wrap=document.createElement('label'), input=document.createElement('select');
          wrap.append(label,input);field.append(wrap);return input;
        }
        const source=select('Tabela de origem'), label=select('Agrupar por'), metric=select('Indicador');
        report.tables.forEach((table,i)=>source.add(new Option(table.name,String(i))));
        function parameters() {
          const table=report.tables[Number(source.value)];
          label.replaceChildren();metric.replaceChildren(new Option('Quantidade de registros','count'));
          table.headers.forEach((header,i)=>{
            label.add(new Option(header,String(i)));
            if(chartData(table,0,String(i)).length) metric.add(new Option('Somar '+header,String(i)));
          });
          const classification=table.headers.findIndex(header=>/situação|status|etapa|categoria|modalidade/i.test(header));
          if(classification>=0)label.value=String(classification);
        }
        source.onchange=parameters;parameters();
        action('Remover gráfico',()=>{field.remove();add.disabled=false;},field);
        chartControls.append(field);add.disabled=chartControls.children.length>=6;
      }
    }});
  },controls);
}

function render() {
  workspaceRevision++;
  if (activeEdital && !db.editais.some(row=>row.id===activeEdital)) activeEdital=null;
  window.clearInterval(headerClockTimer);
  const currentScreen = [group,page,activeEdital,detailMode,Boolean(session)].join(':');
  if (previousScreen !== currentScreen) {
    document.querySelector('.workspace').scrollTop = 0;
    document.scrollingElement.scrollTop = 0;
    previousScreen = currentScreen;
  }
  const nav = byId('nav');
  const view = byId('view');
  const account = byId('account');
  applyScreenAppearance(view);
  for (const node of [nav,view,account,byId("page-actions")]) node.replaceChildren();
  const platformView = master && Object.hasOwn(masterPages,page);
  const customer = groups.find(entry => entry.id === group);
  byId('page-title').textContent = platformView ? masterPages[page]
    : session || !client ? (page === 'equipe' ? 'Minha equipe' : page === 'relatorios' ? 'Relatórios' : screens[page] ?? 'Painel geral')
    : 'Acesso ao sistema';
  byId('connection').textContent = !client ? 'Modo demonstração · dados salvos somente neste navegador'
    : platformView ? 'E-Lementar · desenvolvedora da plataforma'
    : customer ? 'Área da empresa · ' + customer.nome
    : session ? 'Área da empresa' : 'Gestão de licitações e compras governamentais';
  byId('breadcrumb-label').textContent = byId('page-title').textContent;
  byId('workspace-name').textContent = customer?.nome?.toLocaleUpperCase('pt-BR') || 'E-LEMENTAR LICITAÇÕES';
  if (page === 'painel' && (!client || group)) {
    byId('page-title').textContent = 'Clareza para decidir. Controle para crescer.';
    if (client) byId('connection').textContent = 'Sua empresa em movimento, da captação à entrega.';
    if (canWrite()) action('Nova oportunidade',()=>edital(),byId('page-actions'),true).insertAdjacentHTML('afterbegin',icon('plus'));
  }
  if (platformView && page==='clientes') action('Empresas clientes',()=>openMasterPage('masterEmpresas'),byId('page-actions'),true);
  if ((session||!client)&&(group||platformView||!client)) mountScreenReport(view);
  if (client && !session) {
    const access = document.createElement('div');
    access.className = 'auth-layout';
    access.innerHTML = '<section class="auth-intro"><a class="auth-brand" href="./site.html" aria-label="Site da E-Lementar Licitações"><img src="./logo-elementar.png" alt="E-Lementar" width="1254" height="1254"><strong>Licitações</strong></a><h2>Da oportunidade à entrega.</h2><p>Organize editais, propostas e fornecimentos ao poder público.</p></section><section class="auth-access"><h2>Acesse sua empresa</h2><form id="login-form"><label>E-mail<input name="email" type="email" autocomplete="username" required></label><label>Senha<input name="password" type="password" autocomplete="current-password" required></label><button type="submit" class="primary">Entrar</button><p role="alert"></p></form></section>';
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
    const user = customer?.alias || session.user.user_metadata?.username || session.user.email?.split('@')[0] || 'Meu acesso';
    const profile = master ? 'Mestre Criador' : profileLabel(groupRole(),currentCompanyProfile);
    account.innerHTML = `<span class="avatar" aria-hidden="true">${escape(user.slice(0,2).toUpperCase())}</span><div><strong>${escape(user)}</strong><small>${profile}</small></div>`;
    const signout = action('Sair', async () => {
      const {error} = await client.auth.signOut();
      if (error) throw error;
      accessNotice?.remove(); session = null; group = null; master = false; groups = []; clients = []; team = []; page = 'painel'; activeEdital = null; await load(); render();
    },account);
    mountNotifications(account);
    mountAccountStatus(account,customer);
    signout.className = 'signout';
    signout.setAttribute('aria-label','Sair');
    signout.title = 'Sair';
    signout.innerHTML = icon('sair');
    if (master) {
      nav.append(Object.assign(document.createElement('p'),{className:'nav-caption master-caption',textContent:'Mestre Gerenciador'}));
      for(const [key,label] of Object.entries(masterPages)) navAction(key,label,()=>openMasterPage(key),nav);
    }
    if (platformView) { renderMasterPage(view); if (!groups.length) return; }
    if (!groups.length) {
      panel(view,'<p>Nenhum espaço de trabalho disponível para esta conta. Consulte o administrador sobre vínculo, bloqueio ou validade.</p>');
      return;
    }

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
    if (!screenAllowed(key) || (key==='configuracoes' && !canOpenCompanySettings())) continue;
    navAction(key,label,()=>goTo(key),nav);
  }
  if (group) navAction('equipe','Minha equipe',openTeam,nav);
  if (platformView) return;
  if (page === 'equipe' && group) { renderTeam(view); return; }
  if (!screenAllowed(page)) {
    const fallback=Object.keys(screens).find(key=>screenAllowed(key) && (key!=='configuracoes' || canOpenCompanySettings()));
    if(fallback) {goTo(fallback);return;}
    panel(view,'<p>Seu perfil está sem módulos habilitados. Consulte o administrador da empresa.</p>');
    return;
  }
  if (activeEdital) { renderProposal(view,db.editais.find(x => x.id === activeEdital)); return; }
  if(page==='logistica') { renderLogistics(view); return; }
  if (page === 'acompanhamento' || page === 'finalizados') { renderFollow(view); return; }
  if (page === 'disputa') { renderDisputes(view); return; }
  if (page === 'cotacoes' || page === 'orcamento') { renderQuotes(view); return; }
  if (page === 'financeiro') { renderQuoteFinance(view); return; }
  if (page === 'propostas') { renderProposalBoard(view); return; }
  if (page === 'propostaPronta') { renderReadyProposals(view); return; }
  if (page === 'documentacao') { renderAcervo(view).catch(error=>message(error.message)); return; }
  if (page === 'relatorios') { renderReports(view); return; }
  if (page === 'orgaos' || page === 'catalogo') { renderRegistry(view,page === 'orgaos'); return; }
  if (page === 'ajuda') { if(client && group && !master) renderCustomerTickets(view); renderHelp(view); return; }
  if(page==='aplicativo') {
    const installed=matchMedia('(display-mode: standalone)').matches || navigator.standalone===true;
    panel(view,'<h2>Aplicativo</h2><p>Versão '+escape(new URL(import.meta.url).searchParams.get('v'))+'</p><p>'+ (installed?'Aberto como aplicativo.':'Aberto no navegador. Use o menu do navegador para instalar, quando disponível.')+'</p><p>Os dados da empresa dependem de conexão com o sistema.</p>');
    return;
  }
  if (Object.hasOwn(pendingScreens,page)) {
    panel(view,'<h2>Em implantação</h2><p>'+escape(pendingScreens[page])+'</p>');
    return;
  }
  if (page === 'painel') {
    renderOverview(view);
  } else if (page === 'configuracoes') {
    if(canOpenCompanySettings()) renderCompanySettings(view);
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
        const card = panel(lane,'<strong>Processo '+escape(row.numero)+'</strong><p>'+escape(row.orgao)+'</p><p class="muted">'+escape(row.modalidade)+(row.numero_pregao?' · Nº '+escape(row.numero_pregao):'')+'</p>');
        card.classList.add('card');
        writeAction('Analisar',()=>edital(row),card);
        if (row.local_disputa) card.insertAdjacentHTML('beforeend','<p>Disputa: '+escape(row.local_disputa)+'</p>');
        const editalUrl = safeWebUrl(row.edital_url);
        if (editalUrl) card.insertAdjacentHTML('beforeend','<p><a href="'+escape(editalUrl)+'" target="_blank" rel="noopener noreferrer">Abrir publicação do edital</a></p>');
        if (row.edital_pdf_nome) action('Baixar edital',()=>downloadEdital(row),card);
        if (row.status==='Aprovado' || db.itens.some(x=>x.edital_id===row.id)) action('Abrir proposta',()=>{detailMode=null;activeEdital=row.id;render();},card,true);
      }
    }
  }
}

function documentExpired(file) {
  const today = new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Sao_Paulo'}).format(new Date());
  return Boolean(file.validade && file.validade<today);
}

function documentValidity(file) {
  if (!file.validade) return 'Validade não informada';
  return (documentExpired(file)?'Vencido em ':'Válido até ')+file.validade.split('-').reverse().join('/');
}

async function renderAcervo(view) {
  const section = panel(view,'<h2>Acervo de documentos da empresa</h2>');
  if (!client || !db.empresas.length) { section.append('Cadastre um CNPJ participante para criar o acervo.'); return; }
  const select = document.createElement('select');
  select.setAttribute('aria-label','Empresa do documento');
  for (const empresa of db.empresas) select.add(new Option(empresa.nome+' · '+empresa.cnpj,empresa.id));
  section.append(select);
  const list = document.createElement('div');
  section.append(list);
  async function draw() {
    const company = select.value;
    const scope = {grupo_id:group,empresa_id:company};
    const {data,error} = await client.from('arquivos_empresa').select('id,nome,validade').match(scope).order('nome');
    if (error) throw error;
    if (!section.isConnected || select.value!==company) return;
    list.replaceChildren();
    writeAction('Cadastrar documento',()=>edit('Cadastrar documento',[['nome','Nome do documento','text'],['validade','Validade','date'],['arquivo','PDF','file']],async values=>{
      const {error} = await client.from('arquivos_empresa').insert({...scope,nome:values.nome.trim(),validade:values.validade||null,conteudo:await encodePdf(values.arquivo)});
      if (error) throw error;
    },{onSaved:()=>draw().catch(error=>message(error.message))}),list,true);
    if (!data.length) list.append('Nenhum documento cadastrado.');
    for (const file of data) {
      const card = panel(list,'<strong>'+escape(file.nome)+'</strong><p>'+escape(documentValidity(file))+'</p>');
      action('Baixar PDF',async()=>{
        const {data,error} = await client.from('arquivos_empresa').select('conteudo').match({...scope,id:file.id}).single();
        if (error) throw error;
        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data.conteudo),c=>c.charCodeAt(0))],{type:'application/pdf'}));
        const link = document.createElement('a');
        link.href=url;
        link.download=file.nome.replace(/\.pdf$/i,'')+'.pdf';
        link.click();
        setTimeout(()=>URL.revokeObjectURL(url),30000);
      },card);
      writeAction('Editar validade',()=>edit('Editar validade',[['validade','Validade','date',file.validade]],async values=>{
        const {error}=await client.from('arquivos_empresa').update({validade:values.validade||null}).match({...scope,id:file.id});
        if (error) throw error;
      },{onSaved:()=>draw().catch(error=>message(error.message))}),card);
    }
  }
  select.onchange = ()=>draw().catch(error=>message(error.message));
  await draw();
}

async function renderProposalHistory(view,row) {
  const section = panel(view,'<h2>Histórico de movimentações</h2>');
  if (!client) return;
  const {data,error} = await client.from('historico_proposta').select('origem,destino,responsavel,ocorrido_em')
    .match({grupo_id:group,edital_id:row.id}).order('id',{ascending:false});
  if (error) throw error;
  if (!section.isConnected) return;
  if (!data.length) section.append('Nenhuma movimentação registrada.');
  const date = new Intl.DateTimeFormat('pt-BR',{dateStyle:'short',timeStyle:'medium',timeZone:'America/Sao_Paulo'});
  const list = document.createElement('ul');
  list.style.cssText = 'list-style:none;margin:4px 0 0;padding:0;font-size:9pt;line-height:1.3';
  for (const entry of data) {
    const item = document.createElement('li');
    item.style.cssText = 'padding:3px 0;border-bottom:1px solid #e5e7eb;overflow-wrap:anywhere';
    item.innerHTML = '<strong>'+proposalStages[entry.origem]+' → '+proposalStages[entry.destino]+'</strong> · '+escape(entry.responsavel)+' · '+date.format(new Date(entry.ocorrido_em))+' (Brasília)';
    list.append(item);
  }
  section.append(list);
}

async function downloadProposalPackage(row,scope,selected) {
  const {data,error} = await client.from('arquivos_empresa').select('id,nome,conteudo,validade')
    .match({grupo_id:scope.grupo_id,empresa_id:scope.empresa_id}).in('id',[...selected]);
  if (error) throw error;
  if (data.length !== selected.size) throw new Error('Um arquivo vinculado ficou indisponível.');
  if (data.some(documentExpired)) throw new Error('Há documentos vencidos. Volte para Vincular documentação e atualize a seleção.');
  const signed = await readSignedProposal(row);
  const files = data.map((file,index)=>({name:'documentos/'+(index+1)+'-'+(file.nome.replace(/\.pdf$/i,'')+'.pdf').replace(/[^\p{L}\p{N} ._-]/gu,'_'),bytes:Uint8Array.from(atob(file.conteudo),character=>character.charCodeAt(0))}));
  const zip = makeZip([{name:'proposta-inicial-assinada.pdf',bytes:pdfBytes(signed)},...files]);
  const url = URL.createObjectURL(zip);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'proposta-'+row.numero.replace(/[^a-z0-9_-]/gi,'-')+'.zip';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}

async function proposalAttachments(section,row,items) {
  if (!row.empresa_id || !client) return;
  const scope = {grupo_id:group,empresa_id:row.empresa_id,edital_id:row.id};
  const [files,links] = await Promise.all([
    client.from('arquivos_empresa').select('id,nome,validade').match({grupo_id:scope.grupo_id,empresa_id:scope.empresa_id}),
    client.from('anexos_proposta').select('arquivo_id').match(scope)
  ]);
  if (!section.isConnected) return;
  if (files.error || links.error) {
    const error = files.error || links.error;
    if (['PGRST205','42P01'].includes(error.code)) {
      section.append('O envio de arquivos aguarda a atualização do banco de dados.');
      return;
    }
    throw error;
  }
  const selected = new Set(links.data.map(link=>link.arquivo_id));
  const list = panel(section,'<h3>Arquivos do CNPJ participante</h3>');
  if (!files.data.length) list.append('Nenhum arquivo cadastrado.');
  for (const file of files.data) {
    const linked = selected.has(file.id);
    const card = panel(list,'<strong>'+escape(file.nome)+'</strong><p>'+escape(documentValidity(file))+' · '+(linked?'Anexado à proposta':'Disponível para anexar')+'</p>');
    if (proposalStage(row)<3 && (linked || !documentExpired(file))) writeAction(linked?'Desvincular':'Anexar à proposta',async()=>{
      const values = {...scope,arquivo_id:file.id};
      const {error} = await (linked
        ? client.from('anexos_proposta').delete().match(values)
        : client.from('anexos_proposta').upsert(values,{ignoreDuplicates:true}));
      if (error) throw error;
      if (section.isConnected) render();
    },card);
  }
  if (proposalStage(row)===5 && items.length && selected.size) {
    action('Baixar ZIP da proposta',()=>downloadProposalPackage(row,scope,selected),section,true);
  }
}

const printedDescription = item=>item.usar_descricao_interna ? item.descricao_interna || item.descricao : item.descricao;
const proposalIdentity = [
  ['inscricao_estadual','Inscrição estadual'],['inscricao_municipal','Inscrição municipal'],
  ['endereco','Endereço da empresa'],['telefone','Telefone'],['email','E-mail'],
  ['banco','Banco'],['agencia','Agência'],['conta','Conta']
];
const representativeFields = [
  ['signatario','Nome do representante legal'],['cargo','Cargo'],['cpf','CPF'],
  ['rg','RG'],['nacionalidade','Nacionalidade']
];
function companyRepresentatives(company) {
  const identity=company?.dados_proposta??{};
  if(Array.isArray(identity.representantes)) return identity.representantes;
  if(!identity.signatario) return [];
  return [{id:'anterior',...Object.fromEntries(representativeFields.map(([key])=>[key,identity[key]??'']))}];
}
function renderCompanyRepresentatives(card,company) {
  const list=companyRepresentatives(company);
  function editRepresentative(current) {
    edit(current?'Editar representante':'Cadastrar representante',
      representativeFields.map(([key,label])=>[key,label,'text',current?.[key]]),async values=>{
      const fields=Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.trim()]));
      if(!fields.signatario) throw new Error('Informe o nome do representante.');
      fields.cpf=normalizeDocument(fields.cpf);
      if(fields.cpf && (!/^\d{11}$/.test(fields.cpf)||!validDocument(fields.cpf))) throw new Error('Informe um CPF válido com 11 dígitos.');
      if(fields.cpf && list.some(row=>row.id!==current?.id&&normalizeDocument(row.cpf)===fields.cpf)) throw new Error('Esse CPF já está cadastrado para esta empresa.');
      const representante={...fields,id:current?.id??crypto.randomUUID()};
      const representantes=current?list.map(row=>row.id===current.id?representante:row):[...list,representante];
      await save('empresas',{dados_proposta:{...company.dados_proposta,representantes}},company.id);
    },{decorate:form=>{for(const field of form.querySelectorAll('input')) field.required=field.name==='signatario';}});
  }
  const section=panel(card,'<h4>Representantes legais</h4>');
  section.dataset.reportPrivate='';
  participantAction('Cadastrar representante',()=>editRepresentative(),section);
  for(const person of list) {
    const row=panel(section,'<p>'+escape(person.signatario+(person.cargo?' · '+person.cargo:''))+'</p>');
    participantAction('Editar representante',()=>editRepresentative(person),row);
  }
}
function selectDocumentRepresentative(company,generate) {
  const people=companyRepresentatives(company);
  if(people.length<2) return generate(people[0]);
  edit('Selecionar representante para o PDF',[
    ['representante','Representante legal','select',people[0].id,people.map(person=>[person.id,person.signatario+(person.cargo?' · '+person.cargo:'')])]
  ],({representante})=>generate(people.find(person=>person.id===representante)),{onSaved:()=>{}});
}
function placeCompanyLogo(company,pdf,y) {
  const identity=company?.dados_proposta??{};
  if (/^data:image\/(png|jpeg);base64,/.test(identity.logo??'')) {
    const image=pdf.getImageProperties(identity.logo);
    const scale=Math.min(55/image.width,22/image.height);
    pdf.addImage(identity.logo,image.fileType,16,y,image.width*scale,image.height*scale);
    return y+image.height*scale+5;
  }
  return y;
}
function companyProposalSettings(company) {
  const current = company.dados_proposta ?? {};
  edit('Dados da empresa para impressão',[
    ...proposalIdentity.map(([key,label])=>[key,label,'text',current[key]]),
    ['logo','Logomarca da empresa','file']
  ],async values=>{
    const {logo,...details}=values;
    const dados_proposta = {...current,...details};
    if (logo.size) {
      if (logo.size>1024*1024 || !['image/png','image/jpeg'].includes(logo.type)) throw new Error('Use uma logomarca PNG ou JPG de até 1 MB.');
      dados_proposta.logo = await new Promise((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(reader.result);
        reader.onerror = ()=>reject(reader.error);
        reader.readAsDataURL(logo);
      });
    }
    await save('empresas',{dados_proposta},company.id);
  },{decorate:form=>form.querySelectorAll('input').forEach(field=>field.required=false)});
}

function groupProposalItems(items) {
  const groups = new Map();
  for (const item of items) {
    const lot = item.lote ?? '';
    if (!groups.has(lot)) groups.set(lot,[]);
    groups.get(lot).push(item);
  }
  return groups;
}

let pdfLibrary;
async function proposalPdfLibrary() {
  pdfLibrary ??= new Promise((resolve,reject)=>{
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js';
    script.onload = ()=>window.jspdf?.jsPDF ? resolve(window.jspdf.jsPDF) : reject(new Error('Gerador de PDF indisponível.'));
    script.onerror = ()=>{ script.remove(); reject(new Error('Não foi possível carregar o gerador de PDF.')); };
    document.head.append(script);
  }).catch(error=>{ pdfLibrary = undefined; throw error; });
  return pdfLibrary;
}

function downloadProposalPdf(row,items,options={}) {
  const company=db.empresas.find(entry=>entry.id===row.empresa_id);
  return selectDocumentRepresentative(company,representative=>generateProposalPdf(row,items,options,representative));
}

async function generateProposalPdf(row,items,{budget=false,readequada=false},representative) {
  const Pdf = await proposalPdfLibrary();
  const pdf = new Pdf({unit:'mm',format:'a4'});
  const company = db.empresas.find(entry=>entry.id===row.empresa_id);
  const identity = company?.dados_proposta ?? {};
  let y = placeCompanyLogo(company,pdf,16);
  function space(height) {
    if (y+height>277) { pdf.addPage(); y=16; }
  }
  function write(value,{size=10,bold=false}={}) {
    pdf.setFont('helvetica',bold?'bold':'normal');
    pdf.setFontSize(size);
    const step = size*0.46;
    for (const text of pdf.splitTextToSize(String(value??''),178)) {
      space(step);
      pdf.text(text,16,y);
      y+=step;
    }
  }
  write(budget?'ORÇAMENTO COMERCIAL':readequada?'PROPOSTA COMERCIAL READEQUADA':'PROPOSTA COMERCIAL',{size:17,bold:true});
  write('Razão social: '+(company?.nome??''),{bold:true});
  write('CNPJ: '+(company?.cnpj??''));
  for (const [key,label] of proposalIdentity) if (identity[key]) write(label+': '+identity[key]);
  for (const [key,label] of representativeFields) if (representative?.[key]) write(label+': '+representative[key]);
  y+=3;
  write('À atenção do Setor de Licitações — '+row.orgao);
  write(budget?'Referência da solicitação: '+row.numero:'Processo: '+row.numero+' · '+row.modalidade+' '+(row.numero_pregao??''));
  if (row.sessao) write('Data da sessão: '+row.sessao.split('-').reverse().join('/'));
  if (row.local_disputa) write('Local ou portal da disputa: '+row.local_disputa);
  write((budget?'Objeto do orçamento: ':'Objeto: ')+(row.objeto??''));
  if (budget && row.observacao) write(row.observacao);
  for (const [lot,entries] of groupProposalItems(items)) {
    if (lot) { y+=3; write('Lote '+lot,{bold:true}); }
    for (const item of entries) {
      y+=3;
      space(16);
      const code = catalogCode(item);
      write('Item '+item.codigo+(code?' · Código interno '+code:''),{bold:true});
      write(printedDescription(item));
      write([item.quantidade+' '+(item.unidade??''),item.marca,'Unitário: '+money.format(price(item)),'Total: '+money.format(total([item]))].filter(Boolean).join(' · '));
    }
    if (lot) write('Subtotal do lote: '+money.format(total(entries)),{bold:true});
  }
  y+=4;
  write((budget?'Valor total do orçamento: ':'Valor total da proposta: ')+money.format(total(items)),{size:12,bold:true});
  space(35);
  y+=16;
  pdf.line(16,y,103,y);
  y+=5;
  write(representative?.signatario || company?.nome || 'Representante da empresa participante',{bold:true});
  if (identity.cargo) write(identity.cargo);
  write('Assinatura do representante');
  for (let page=1;page<=pdf.getNumberOfPages();page++) {
    pdf.setPage(page);
    pdf.setFont('helvetica','normal');
    pdf.setFontSize(7);
    pdf.setTextColor(115);
    pdf.text('Gerado pelo E-Lementar Licitações',194,289,{align:'right'});
  }
  pdf.save((budget?'orcamento-':readequada?'proposta-readequada-':'proposta-')+row.numero.replace(/[^a-z0-9_-]/gi,'-')+'.pdf');
}

const pdfBytes = base64=>Uint8Array.from(atob(base64),character=>character.charCodeAt(0));

async function readSignedProposal(row) {
  const {data,error} = await client.from('propostas_assinadas').select('pdf').match({grupo_id:group,edital_id:row.id}).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Volte à Conferência 02 e anexe o PDF assinado para gerar o ZIP.');
  return data.pdf;
}

async function renderProposalSignature(view,row) {
  const section = panel(view,'<h2>Assinatura da proposta</h2>');
  const {data,error} = await client.from('propostas_assinadas').select('anexado_em').match({grupo_id:group,edital_id:row.id}).maybeSingle();
  if (error) throw error;
  if (!section.isConnected) return;
  section.append(data?'PDF assinado anexado.':'Baixe o PDF da proposta. Assine digitalmente ou imprima, assine e digitalize. Em seguida, anexe o PDF assinado.');
  if (data) action('Baixar PDF assinado',async()=>{
    const url = URL.createObjectURL(new Blob([pdfBytes(await readSignedProposal(row))],{type:'application/pdf'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'proposta-assinada.pdf';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  },section);
  if (proposalStage(row)===4) writeAction(data?'Substituir PDF assinado':'Anexar PDF assinado',()=>edit('Anexar proposta assinada',
    [['arquivo','Proposta assinada em PDF','file']],async ({arquivo})=>{
      const {error} = await client.rpc('anexar_proposta_assinada',{p_edital:row.id,p_pdf:await encodePdf(arquivo)});
      if (error) throw error;
    },{decorate:form=>{form.elements.namedItem('arquivo').accept='.pdf,application/pdf';}}),section,true);
}

const importColumns = ['ITEM','QTD','UND','DESCRICAO_EDITAL','MARCA','CUSTO','MARGEM','FORNECEDOR','OBSERVACAO','CODIGO_CATALOGO','DESCRICAO_NA_PROPOSTA','LOTE'];
const catalogColumns = ['DESCRICAO','TIPO','UNIDADE','MARCA','DETALHES','OBSERVACAO','CUSTO','MARGEM'];
const catalogCode = item=>db.catalogo.find(entry=>entry.id===item.catalogo_id)?.codigo??'';

function importCatalog() {
  edit('Importar catálogo de produtos e serviços',[['planilha','Planilha do catálogo (.xlsx)','file']],async ({planilha})=>{
    if (!/\.xlsx$/i.test(planilha.name) || !planilha.size || planilha.size>2*1024*1024) throw new Error('Selecione uma planilha .xlsx de até 2 MB.');
    const lines = await readExcelItems(planilha);
    if (lines.shift()?.join('|') !== catalogColumns.join('|')) throw new Error('Use os cabeçalhos do modelo do catálogo.');
    const records = [];
    for (const [index,cells] of lines.entries()) {
      if (!cells.some(Boolean)) continue;
      try {
        if (cells.slice(catalogColumns.length).some(Boolean)) throw new Error('Remova as colunas extras.');
        const [descricao,tipo,unidade,marca,detalhes,observacao,custo,margem] = catalogColumns.map((_,column)=>cells[column]??'');
        records.push(catalogValues({descricao,tipo,unidade,marca,detalhes,observacao,custo,margem}));
      } catch(error) { throw new Error('Linha '+(index+2)+': '+error.message); }
    }
    if (!records.length) throw new Error('Inclua pelo menos um produto ou serviço.');
    if (client) {
      const {error} = await client.from('catalogo').insert(records.map(record=>({...record,grupo_id:group})),{defaultToNull:false});
      if (error) throw error;
      await load();
    } else {
      const updated = [...db.catalogo,...records.map(record=>{
        const id = crypto.randomUUID();
        return {...record,id,codigo:'CAT-'+id};
      })];
      localStorage.setItem(localKey,JSON.stringify({...db,catalogo:updated}));
      db.catalogo = updated;
    }
  },{decorate:form=>{form.elements.namedItem('planilha').accept='.xlsx';}});
}
async function readExcelItems(file) {
  if (!globalThis.XLSX) {
    await new Promise((resolve,reject)=>{
      const script = document.createElement('script');
      script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      script.onload = resolve;
      script.onerror = ()=>{script.remove();reject(new Error('O leitor de Excel não carregou. Tente novamente.'));};
      document.head.append(script);
    });
  }
  let book;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) throw new Error();
    book = XLSX.read(bytes,{sheets:0,sheetRows:1002});
  } catch {
    throw new Error('O arquivo não é uma planilha .xlsx válida. Use o modelo do sistema.');
  }
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) throw new Error('A planilha está vazia.');
  const rows = XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',raw:true,blankrows:true});
  if (rows.length > 1001) throw new Error('Importe até 1.000 itens por planilha.');
  return rows.map(row=>row.map(value=>String(value).trim()));
}

function importProposalItems(row) {
  edit('Importar itens da proposta',[['planilha','Planilha do Excel','file']],async ({planilha})=>{
    if (!planilha.size || planilha.size > 2*1024*1024) throw new Error('Selecione uma planilha de até 2 MB.');
    const isExcel = /\.xlsx$/i.test(planilha.name);
    const lines = isExcel ? await readExcelItems(planilha) : readXmlItems(await planilha.text());
    const header = lines.shift()?.join('|');
    if (header !== importColumns.join('|') && !(row.modo_disputa!=='lote' && header===importColumns.slice(0,-1).join('|'))) throw new Error('Mantenha os nomes e a ordem das colunas do modelo.');
    const seen = new Set();
    const items = [];
    for (const [index,cells] of lines.entries()) {
      if (!cells.some(Boolean)) continue;
      const [codigo,quantidade,unidade,descricao,marca_item,custo_embalagem,margem,fornecedor,observacao_item,catalogCode,source,lote] = importColumns.map((_,column)=>cells[column]??'');
      try {
        if (cells.slice(importColumns.length).some(Boolean)) throw new Error('Remova as colunas extras.');
        const key = JSON.stringify([lote,codigo]);
        if (seen.has(key)) throw new Error('Número de item duplicado na planilha.');
        const product = db.catalogo.find(entry=>entry.codigo===catalogCode);
        if (catalogCode && !product) throw new Error('Código do catálogo não localizado: '+catalogCode);
        const origem_descricao = source.toLowerCase() || 'edital';
        if (!['edital','interna'].includes(origem_descricao)) throw new Error('Use edital ou interna na origem da descrição.');
        items.push(proposalItem(row,{lote,codigo,quantidade,unidade,descricao,marca_item,custo_embalagem,margem,fornecedor,
          observacao_item,embalagem:'1',produto_catalogo:product?.id,origem_descricao}));
        seen.add(key);
      } catch(error) { throw new Error('Linha '+(index+2)+': '+error.message); }
    }
    if (!items.length) throw new Error('Inclua pelo menos um item.');
    if (client) {
      const {error} = await client.from('itens').insert(items.map(item=>({...item,grupo_id:group})));
      if (error) throw error;
      await load();
    } else {
      const updated = [...db.itens,...items.map(item=>({...item,id:crypto.randomUUID()}))];
      localStorage.setItem(localKey,JSON.stringify({...db,itens:updated}));
      db.itens = updated;
    }
  },{decorate:form=>{form.elements.namedItem('planilha').accept='.xlsx,.xml';}});
}

function readXmlItems(text) {
    const xml = new DOMParser().parseFromString(text,'application/xml');
    const ns = 'urn:schemas-microsoft-com:office:spreadsheet';
    const table = xml.getElementsByTagNameNS(ns,'Table')[0];
    if (xml.querySelector('parsererror') || !table) throw new Error('Use o modelo XML de itens.');
    return [...table.getElementsByTagNameNS(ns,'Row')].map(line=>{
      const cells = [];
      for (const cell of line.getElementsByTagNameNS(ns,'Cell')) {
        const index = Number(cell.getAttributeNS(ns,'Index') || cells.length+1);
        if (!Number.isInteger(index) || index<=cells.length || index>importColumns.length) throw new Error('A planilha contém colunas fora do modelo.');
        cells[index-1] = cell.textContent.trim();
      }
      return Array.from({length:importColumns.length},(_,index)=>cells[index]??'');
    });
}

function renderProposal(view,row) {
  const rows = db.itens.filter(x=>x.edital_id===row.id);
  
  const section = panel(view,'<h2>Proposta · '+escape(row.numero)+'</h2><p>'+escape(row.orgao)+' · '+escape(db.empresas.find(e=>e.id===row.empresa_id)?.nome)+'</p><p>Total estimado <strong>'+money.format(total(rows))+'</strong></p>');
  section.insertAdjacentHTML('beforeend','<p>Etapa: <strong>'+proposalStages[proposalStage(row)]+'</strong></p>');
  processSummary(section,row,rows.length?'Próxima ação: '+proposalStages[proposalStage(row)]:'Pendência: adicionar itens à proposta');
  proposalControls(section,row);
  if (proposalStage(row)>=4 && client) renderProposalSignature(view,row).catch(error=>message(error.message));
  if (row.status==='Aprovado' && proposalStage(row)<3) {
    writeAction('Adicionar item',()=>item(row),section,true);
    writeAction('Importar planilha Excel',()=>importProposalItems(row),section);
    if (canWrite()) section.insertAdjacentHTML('beforeend',' <a href="./modelo-itens-proposta.xlsx" download>Baixar modelo Excel (.xlsx)</a>');
  }
  if (rows.length && row.empresa_id) action('Baixar proposta em PDF',()=>downloadProposalPdf(row,rows),section);
  const table = document.createElement('div');
  table.className = 'scroll';
  table.innerHTML = '<table><thead><tr><th>Lote</th><th>Item</th><th>Código interno</th><th>Descrição</th><th>Qtde.</th><th>Und.</th><th>Marca</th><th>Custo unitário</th><th>Margem</th><th>Fornecedor</th><th>Observação</th><th>Preço proposto</th><th>Total</th><th>Ações</th></tr></thead><tbody></tbody></table>';
  section.append(table);
  for (const entry of rows) {
    const tr = table.querySelector('tbody').insertRow();
    for (const value of [entry.lote,entry.codigo,catalogCode(entry),printedDescription(entry),decimal.format(entry.quantidade),entry.unidade,entry.marca,decimal.format(entry.custo_embalagem/entry.embalagem),decimal.format(entry.margem)+'%',entry.fornecedor,entry.observacao,money.format(price(entry)),money.format(total([entry]))]) tr.insertCell().textContent=value;
    const controls=tr.insertCell();
    if(row.status==='Aprovado' && proposalStage(row)<3) {
      writeAction('Editar',()=>item(row,entry),controls);
      demoDelete('itens',entry.id,controls);
    }
  }
  const attachments = panel(view,'<h2>Documentos selecionados para disputa</h2>');
  proposalAttachments(attachments,row,rows).catch(error=>{if(attachments.isConnected) message(error.message);});
  renderProposalHistory(view,row).catch(error=>message(error.message));
}

async function loadGroups(){
  const {data,error}=await client.from('membros').select('papel,alias_empresa,acesso_ate,grupos(id,nome,acesso_modo,acesso_ate)');
  if(error) throw error;
  groups=data.filter(m=>m.grupos).map(m=>({...m.grupos,role:m.grupos.acesso_modo==='leitura'?'leitor':m.papel,alias:m.alias_empresa,memberExpiry:m.acesso_ate}));
  const capability = await client.rpc('licitacoes_eh_mestre');
  if (capability.error && capability.error.code !== 'PGRST202') throw capability.error;
  master = capability.data === true;
  if(master && page==='painel') page='clientes';
  group=groups[0]?.id;
  await load();
}

const versionBanner = byId('version-notice');
let checkingVersion = false;
let availableVersion;
async function checkVersion() {
  if (checkingVersion || availableVersion) return;
  checkingVersion = true;
  try {
    const response = await fetch(new URL('./index.html',import.meta.url),{cache:'no-store'});
    if (!response.ok) return;
    const next = new DOMParser().parseFromString(await response.text(),'text/html').querySelector('#app-entry');
    if (!next) return;
    const version = new URL(next.getAttribute('src'),response.url);
    if (version.href === import.meta.url) return;
    availableVersion = version.searchParams.get('v');
    if (availableVersion) versionBanner.hidden = false;
  } catch {
    // A temporary connection error should leave the current version usable.
  } finally {
    checkingVersion = false;
  }
}
versionBanner.querySelector('button').onclick = () => {
  if (document.querySelector('dialog[open]')) return;
  const url = new URL(location.href);
  url.searchParams.set('v',availableVersion);
  location.replace(url);
};
window.addEventListener('focus',checkVersion);
window.setInterval(checkVersion,60000);

let checkingAccess=false;
let accessNotice;
const accessSignature=(rules,profile)=>JSON.stringify([profile??null,Object.keys(screens).map(key=>rules?.[key]??null)]);
async function checkSessionAccess() {
  if(!client||!session?.user||master||checkingAccess||document.hidden) return;
  const currentGroup=group;
  const user=session.user.id;
  checkingAccess=true;
  try {
    if(!currentGroup) {
      await loadGroups();
      if(group && session?.user?.id===user) {
        accessNotice?.remove();
        render();
      }
      return;
    }
    const [rules,profile]=await Promise.all([
      call('licitacoes_minhas_telas',{empresa:currentGroup}),
      call('licitacoes_meu_cargo',{empresa:currentGroup})
    ]);
    if(group!==currentGroup||session?.user?.id!==user) return;
    if(accessSignature(rules,profile)===accessSignature(screenAccess,currentCompanyProfile)) {
      accessNotice?.remove();
      return;
    }
    if(accessNotice?.isConnected) return;
    accessNotice=document.createElement('section');
    accessNotice.className='line';
    accessNotice.setAttribute('role','status');
    accessNotice.append('Seu perfil ou suas permissões foram alterados.');
    const button=action('Atualizar meu acesso',async ()=>{
      if(document.querySelector('dialog[open]')) {message('Feche o formulário aberto antes de atualizar o acesso.');return;}
      button.disabled=true;
      try {
        await loadGroups();
        if(groups.some(item=>item.id===currentGroup) && group!==currentGroup) {group=currentGroup;await load();}
        accessNotice.remove();
        render();
      } finally {button.disabled=false;}
    },accessNotice,true);
    versionBanner.after(accessNotice);
  } catch {
    // A falha temporária será tratada na próxima verificação.
  } finally {checkingAccess=false;}
}
window.addEventListener('focus',checkSessionAccess);
window.setInterval(checkSessionAccess,15000);

const workspaceSyncTables = {
  painel:['empresas','editais','itens','disputas','acompanhamentos'],
  editais:['empresas','editais','orgaos_compradores'],
  propostas:['empresas','editais','itens'],
  propostaPronta:['empresas','editais','itens'],
  disputa:['empresas','editais','itens','disputas'],
  acompanhamento:['empresas','editais','itens','disputas','acompanhamentos'],
  finalizados:['empresas','editais','itens','disputas','acompanhamentos'],
  orgaos:['orgaos_compradores'],
  catalogo:['catalogo'],
  cotacoes:['empresas','catalogo','cotacoes'],
  orcamento:['empresas','orgaos_compradores','cotacoes'],
  financeiro:['catalogo','cotacoes']
};
let syncingWorkspace = false;
let draggingWorkspace = false;

byId('view').addEventListener('dragstart',()=>{draggingWorkspace=true;});
document.addEventListener('dragend',()=>{draggingWorkspace=false;});
document.addEventListener('drop',()=>{draggingWorkspace=false;});

function workspaceViewIsIdle() {
  const focused = document.activeElement;
  return !document.hidden && !pendingActions && !draggingWorkspace
    && !document.querySelector('dialog[open]')
    && !(byId('view').contains(focused) && focused.matches('input,select,textarea,[contenteditable]'));
}

function workspaceRowsChanged(previous,next) {
  if (previous.length!==next.length) return true;
  const previousById = new Map(previous.map(row=>[row.id,JSON.stringify(row)]));
  return next.some(row=>previousById.get(row.id)!==JSON.stringify(row));
}

async function refreshWorkspace() {
  const tables = activeEdital ? workspaceSyncTables.propostas : workspaceSyncTables[page];
  if (!client || !session?.user || !group || !tables || syncingWorkspace || !workspaceViewIsIdle()) return;
  const company=group;
  const user=session.user.id;
  const revision=workspaceRevision;
  syncingWorkspace=true;
  try {
    const results=await Promise.all(tables.map(table=>workspaceQuery(table,company)));
    if (group!==company || session?.user?.id!==user || revision!==workspaceRevision || !workspaceViewIsIdle()) return;
    const changes=results.flatMap(({data,error},index)=>{
      const table=tables[index];
      return !error && Array.isArray(data) && workspaceRowsChanged(db[table],data) ? [[table,data]] : [];
    });
    if (!changes.length) return;
    for (const [table,rows] of changes) db[table]=rows;
    render();
  } catch {
    // Uma falha de rede será retomada no próximo ciclo.
  } finally {
    syncingWorkspace=false;
  }
}
window.addEventListener('focus',refreshWorkspace);
document.addEventListener('visibilitychange',refreshWorkspace);
window.setInterval(refreshWorkspace,10000);

void checkVersion();

try {
  if(client){
    const {data,error}=await client.auth.getSession();
    if(error) throw error;
    session=data.session;
    const route=new URLSearchParams(location.search);
    if(!session && !route.has('acesso') && !route.has('v')) location.replace('./site.html');
    if(session) {
      await loadGroups();
      if(master) await openClients();
    }
  } else await load();
  render();
} catch(error) { render(); message(error.message); }

function clampWorkspaceText() {
  for (const cell of byId('view').querySelectorAll('tbody td')) {
    if (cell.childElementCount || !cell.textContent.trim()) continue;
    const text=document.createElement('span');
    text.className='workspace-text-preview';
    text.textContent=cell.textContent;
    text.title=text.textContent;
    cell.replaceChildren(text);
  }
  for (const text of byId('view').querySelectorAll('.card p,.card strong')) {
    if (text.childElementCount || !text.textContent.trim()) continue;
    text.classList.add('workspace-card-preview');
    text.title=text.textContent;
  }
}
const workspaceTextObserver=new MutationObserver(clampWorkspaceText);
workspaceTextObserver.observe(byId('view'),{childList:true,subtree:true});
clampWorkspaceText();
