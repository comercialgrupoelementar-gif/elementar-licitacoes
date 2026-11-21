import {supabaseUrl,supabasePublishableKey} from './config.mjs';
const form=document.querySelector('#lead-form');
const status=document.querySelector('#result');
form.addEventListener('submit',async event=>{
  event.preventDefault();
  event.submitter.disabled=true;
  status.textContent='Enviando solicitação…';
  const fields=new FormData(form);
  try {
    if (!fields.get('website')) {
      const client=window.supabase.createClient(supabaseUrl,supabasePublishableKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
      const {error}=await client.rpc('licitacoes_solicitar_contato',{
        p_nome:fields.get('nome'),p_empresa:fields.get('empresa'),p_email:fields.get('email'),p_interesse:fields.get('interesse')
      });
      if(error) throw error;
    }
    form.reset();
    status.textContent='Solicitação recebida. A equipe da E-Lementar entrará em contato.';
  } catch {
    status.textContent='Não foi possível enviar. Confira os dados e tente novamente.';
  } finally {
    event.submitter.disabled=false;
  }
});
