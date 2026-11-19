# E-lementar Licitações

Primeira versão do fluxo de captação, análise, CNPJs, precificação e checklist de documentação.

## Executar

Sirva a pasta por HTTP, por exemplo com `python -m http.server 8080`, e abra http://localhost:8080. Com a configuração vazia, o modo demonstração salva dados no navegador. Use informações fictícias nesse modo.

## Supabase

1. Aplique `supabase/migrations/202611190001_initial.sql` em um projeto vazio.
2. Cadastre um usuário no Supabase Auth, crie uma linha em `public.grupos` e vincule o UUID do usuário em `public.membros`. A operação de provisionamento é administrativa.
3. Preencha `config.mjs` com URL do projeto e chave **publishable**. Mantenha chaves secretas fora do frontend e do Git.
4. Sirva a aplicação em hospedagem estática HTTPS. Teste acesso com membros de dois grupos e um perfil leitor antes de usar dados reais.

A migração restringe leitura e escrita por grupo e papel. O primeiro recorte tem cadastro manual do órgão e do parecer. Ficam pendentes integração com portais, decisão assistida por regras legais, anexos, cenários, exportação de proposta, administração global, disputa, contratos e logística.
