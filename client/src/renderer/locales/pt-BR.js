// Português (Brasil): the pt-BR translation of the interface.
// The source of truth is en.js -- same keys, same order. A missing key falls
// back to English. Keep every {placeholder} exactly as written there.

export default {

  // --- account
  'account.delete_details': 'A conta e todas as mensagens que a pessoa já escreveu serão removidas do servidor. As mensagens fixadas e os anexos vão junto. Isso não pode ser desfeito.',
  'account.removed': { one: '{who} removido, com {count} mensagem.', other: '{who} removido, com {count} mensagens.' },

  // --- account_confirm_field
  'account_confirm_field.confirm_password': 'Confirmar senha',

  // --- account_fields
  'account_fields.remember_me': 'Lembrar de mim',
  'account_fields.username': 'Nome de usuário',
  'account_fields.your_name': 'seu-nome',

  // --- add_stream
  'add_stream.add_a_stream': 'Adicionar transmissão',

  // --- add_stream_close
  'add_stream_close.cancel': 'Cancelar',

  // --- add_stream_empty
  'add_stream_empty.no_other_streams_are': 'Nenhuma outra transmissão está ao vivo agora.',

  // --- admin
  'admin.promote_details': 'A pessoa poderá criar e excluir canais, silenciar e mover qualquer um à força e excluir as mensagens de qualquer um. Só você pode desfazer isso.',

  // --- app
  'app.a_composition_is_shared_without': 'Uma composição é compartilhada sem som neste computador.',
  'app.add': 'Adicionar',
  'app.add_a_reaction': 'Adicionar reação',
  'app.already_registered': 'Já tem conta?',
  'app.an_admin_muted_your_microphone': 'Um admin silenciou seu microfone.',
  'app.at_least_6_characters': 'Pelo menos 6 caracteres',
  'app.attachment': 'anexo',
  'app.attachment_2': '(anexo)',
  'app.back_to_an_ordinary_member': 'Voltar a ser um membro comum',
  'app.back_to_stream': 'Voltar à transmissão',
  'app.back_to_the_grid': 'Voltar à grade',
  'app.cancel': 'Cancelar',
  'app.cancelling': 'Cancelando…',
  'app.change': 'Alterar…',
  'app.change_hotkey': 'Alterar atalho ({current})',
  'app.change_source': 'Alterar fonte',
  'app.change_source_or_stop_sharing': 'Alterar fonte ou parar de compartilhar',
  'app.change_the_name_or_put': 'Altere o nome ou coloque uma senha',
  'app.change_what_the_heading_says': 'Altere o que o título diz',
  'app.checking': 'Verificando {address}…',
  'app.checking_2': 'Verificando…',
  'app.choose': 'Escolher…',
  'app.choose_a_password': 'Escolha uma senha',
  'app.clear': 'Limpar',
  'app.click_then_press_a_combination': 'Clique e pressione uma combinação',
  'app.click_to_change': 'Clique para alterar',
  'app.click_to_expand': 'Clique para expandir',
  'app.click_to_see_the_attachment': 'Clique para ver o anexo',
  'app.click_to_switch_or_add': 'Clique para trocar ou adicionar um servidor',
  'app.click_to_switch_or_add_2': '{address} -- clique para trocar ou adicionar um servidor',
  'app.clip_saved_s_mb': 'Clipe salvo — {seconds}s, {size} MB',
  'app.clips_off': 'Clipes desativados.',
  'app.clips_on_the_last_s': 'Clipes ativados — os últimos {CLIP_SECONDS}s de cada transmissão serão mantidos na memória.',
  'app.close': 'Fechar {username}',
  'app.closed_click_to_watch_again': 'Fechada · clique para assistir de novo',
  'app.colour': 'Cor {colour}',
  'app.connect': 'Conectar',
  'app.connecting': 'Conectando…',
  'app.connecting_to': 'Conectando a {username}…',
  'app.connection_quality_measuring': 'Qualidade da conexão: medindo',
  'app.connection_quality_milliseconds': 'Qualidade da conexão: {ms} milissegundos',
  'app.continue': 'Continuar',
  'app.could_not_add': 'Não foi possível adicionar {name}: {message}',
  'app.could_not_apply_the_camera': 'Não foi possível aplicar o fundo da câmera ({message}). Usando a câmera normal.',
  'app.could_not_be_registered': 'Não foi possível criar a conta.',
  'app.could_not_join': 'Não foi possível entrar: {error}',
  'app.could_not_list_audio_devices': 'Não foi possível listar os dispositivos de áudio: {message}',
  'app.could_not_open_that_audio': 'Não foi possível abrir essa entrada de áudio: {message}',
  'app.could_not_play': 'Não foi possível tocar "{name}": {message}',
  'app.could_not_read_that_image': 'Não foi possível ler essa imagem.',
  'app.could_not_save_the_clip': 'Não foi possível salvar o clipe: {message}',
  'app.could_not_share_your_screen': 'Não foi possível compartilhar sua tela: {message}',
  'app.could_not_switch_camera': 'Não foi possível trocar de câmera.',
  'app.could_not_update': 'Não foi possível atualizar: {message}',
  'app.create': 'Criar',
  'app.create_account': 'Criar conta',
  'app.create_one': 'Crie uma',
  'app.deafen': 'Ensurdecer',
  'app.deafened': 'Ensurdecido',
  'app.delete': 'Excluir #{name}?',
  'app.delete_2': 'Excluir',
  'app.delete_s_account': 'Excluir a conta de {who}?',
  'app.delete_the_account': 'Excluir a conta',
  'app.delete_the_clip': 'Excluir o clipe "{name}"?',
  'app.delete_the_group': 'Excluir o grupo "{name}"?',
  'app.delete_the_group_2': 'Excluir o grupo',
  'app.delete_this_channel': 'Excluir este canal',
  'app.delete_this_group': 'Excluir este grupo',
  'app.delete_this_message': 'Excluir esta mensagem?',
  'app.disconnected_you': '{by} desconectou você.',
  'app.display_name': 'Nome de exibição',
  'app.download': 'Baixar',
  'app.download_2': 'Baixar ({attachmentBytes})',
  'app.downloading': 'Baixando {name}… {received}',
  'app.downloading_in_the_background': 'Baixando {name} em segundo plano.',
  'app.drag_to_another_voice_channel': 'Arraste para outro canal de voz para mover, ou clique com o botão direito para ver os controles',
  'app.edit': 'Editar #{name}',
  'app.edit_2': 'Editar',
  'app.edit_message': 'Editar mensagem',
  'app.edit_the_layout': 'Editar o layout',
  'app.emoji': 'Emoji',
  'app.end_the_share_for_everybody': 'Encerrar o compartilhamento para todos que estão assistindo',
  'app.end_the_stream_for_everybody': 'Encerrar a transmissão para todos que estão assistindo',
  'app.everything_written_in_it_goes': 'Tudo que foi escrito nele também será excluído. Isso não pode ser desfeito.',
  'app.exit_fullscreen_esc': 'Sair da tela cheia (Esc)',
  'app.folders_cannot_be_sent_zip': 'Não é possível enviar pastas. Compacte em um zip primeiro, ou solte os arquivos de dentro dela.',
  'app.force_mute': 'Silenciar à força',
  'app.forget_this_server_and_the': 'Esquecer este servidor e o login salvo para ele',
  'app.fullscreen': 'Tela cheia',
  'app.game_night': 'Noite de jogos',
  'app.go_to_the_message_this': 'Ir para a mensagem respondida',
  'app.going_live': 'Entrando ao vivo…',
  'app.gradient': 'Gradiente {name}',
  'app.group_a_folder': 'Grupo (uma pasta)',
  'app.harmony': 'Harmony {current}',
  'app.harmony_is_available': 'O Harmony {version} está disponível.',
  'app.harmony_is_ready_to_install': 'O Harmony {version} está pronto para instalar.',
  'app.harmony_voices_soundpad_and_sounds': 'Harmony — vozes, Soundpad e sons (recomendado)',
  'app.hear_my_own_audio': 'Ouvir meu próprio áudio',
  'app.hear_your_own_stream': 'Ouvir sua própria transmissão',
  'app.hide': 'Ocultar',
  'app.hide_preview': 'Ocultar pré-visualização',
  'app.hide_the_preview': 'Ocultar a pré-visualização',
  'app.how_loudly_you_hear_this': 'Quão alto você ouve esta pessoa',
  'app.in_the_channel': '{n} no canal',
  'app.in_voice': 'Em voz',
  'app.is_files_on_this_server': '{name} tem {size}. Os arquivos neste servidor são limitados a {limit}.',
  'app.is_full_people': '{name} está lotado ({cap} pessoas).',
  'app.is_not_answering_click_to': '{address} não está respondendo -- clique para trocar ou adicionar um servidor',
  'app.join': 'Entrar',
  'app.join_a_voice_channel_first': 'Entre em um canal de voz primeiro.',
  'app.jump_to_this_message': 'Ir para esta mensagem',
  'app.kind': 'Tipo',
  'app.later': 'Depois',
  'app.leave_the_password_empty_to': 'Deixe a senha em branco para removê-la.',
  'app.live_as': 'Ao vivo como {username}',
  'app.live_updates_unavailable': 'Atualizações ao vivo indisponíveis: {message}',
  'app.locked': 'bloqueado',
  'app.louder_than_the_original_amplified': 'Mais alto que o original. Áudio amplificado pode distorcer.',
  'app.make_admin': 'Tornar admin',
  'app.make_an_admin': 'Tornar {name} admin?',
  'app.matching': 'Com "{value}"',
  'app.maximize': 'Maximizar {username}',
  'app.maximize_2': 'Maximizar {name}',
  'app.message': 'Mensagem',
  'app.move_down': 'Mover para baixo',
  'app.move_this_person': 'Mover esta pessoa',
  'app.move_up': 'Mover para cima',
  'app.moved_you_to': '{by} moveu você para {name}.',
  'app.mute': 'Silenciar {username}',
  'app.mute_2': 'Silenciar',
  'app.mute_everything': 'Silenciar tudo',
  'app.mute_for_me': 'Silenciar para mim',
  'app.mute_mic': 'Silenciar microfone',
  'app.mute_the_soundpad': 'Silenciar o Soundpad',
  'app.mute_this_share': 'Silenciar este compartilhamento',
  'app.muted': 'Silenciado',
  'app.muted_2': 'silenciado',
  'app.name': 'Nome',
  'app.name_this_clip': 'Dê um nome a este clipe',
  'app.name_this_emoji': 'Dê um nome a este emoji',
  'app.needs_a_password': '{name} precisa de senha',
  'app.new_channel': 'Novo canal',
  'app.nickname': 'Nome de usuário',
  'app.no_account_yet': 'Ainda não tem conta?',
  'app.no_audio': 'Sem áudio',
  'app.no_clips_yet_add_one': 'Nenhum clipe ainda. Adicione um.',
  'app.no_gpu_encoder_available_falling': 'Nenhum codificador de GPU disponível ({videoEncode}) — usando H.264 por software, que é mais lento, mas funciona em qualquer lugar.',
  'app.no_matches': 'Nenhum resultado ({mode}).',
  'app.no_password': 'Sem senha',
  'app.no_picture_chosen': 'Nenhuma foto escolhida',
  'app.nobody_has_added_any_clips': 'Ninguém adicionou clipes.',
  'app.not_set': 'Não definido',
  'app.not_you': 'Não é você?',
  'app.nothing_called': 'Nada chamado "{value}".',
  'app.nothing_matching': 'Nada com "{value}".',
  'app.nothing_share_all_system_audio': 'Nada — compartilhar todo o áudio do sistema',
  'app.nothing_to_monitor_this_source': 'Nada para monitorar: esta fonte não tem áudio',
  'app.notifies_the_whole_server': 'notifica o servidor inteiro',
  'app.off': 'Desativado',
  'app.off_encoding_on_the_cpu': 'Desativado — codificando na CPU. Ative de novo, a menos que os espectadores tenham visto a imagem corrompida.',
  'app.one_file_per_message_is': 'Um arquivo por mensagem: {name} está anexado. Envie-o e depois solte o próximo.',
  'app.one_place_higher_in_the': 'Uma posição acima na lista',
  'app.one_place_lower_in_the': 'Uma posição abaixo na lista',
  'app.online': 'Online',
  'app.open_to_everyone': 'Aberto a todos',
  'app.p_fps': '{height}p · {fps} fps',
  'app.password': 'Senha',
  'app.pause': 'Pausar',
  'app.pin': 'Fixar',
  'app.play_this_clip_from_anywhere': 'Toque este clipe de qualquer lugar, até dentro de um jogo',
  'app.preview_hidden': 'Pré-visualização oculta',
  'app.preview_hidden_you_are_still': 'Pré-visualização oculta. Você continua ao vivo — isso só impede o Harmony de desenhá-la.',
  'app.preview_paused': 'Pré-visualização pausada',
  'app.react': 'Reagir',
  'app.reactions_that_used_it_keep': 'As reações que usavam esse emoji mantêm a contagem e voltam a mostrar o texto.',
  'app.recent': 'Recentes',
  'app.reconnecting': 'Reconectando…',
  'app.remove': 'Remover :{name}:',
  'app.remove_2': 'Remover :{name}:?',
  'app.remove_3': 'Remover',
  'app.remove_admin': 'Remover admin',
  'app.remove_hotkey': 'Remover atalho',
  'app.remove_s_admin': 'Remover o admin de {name}?',
  'app.removes_the_channel_and_everything': 'Remove o canal e tudo que foi escrito nele',
  'app.rename': 'Renomear "{name}"',
  'app.rename_or_set_a_password': 'Renomeie ou defina uma senha',
  'app.rename_this_group': 'Renomear este grupo',
  'app.reopen': 'Reabrir {username}',
  'app.replace': 'Substituir',
  'app.replace_this_file': 'Substituir este arquivo',
  'app.reply': 'Responder',
  'app.restart': 'Reiniciar',
  'app.restart_to_update': 'Reiniciar para atualizar?',
  'app.resume': 'Retomar',
  'app.right_click_for_admin_controls': 'Clique com o botão direito para ver os controles de admin',
  'app.right_click_for_volume_and': 'Clique com o botão direito para ver o volume e os controles',
  'app.save': 'Salvar',
  'app.save_the_last_seconds': 'Salvar os últimos {CLIP_SECONDS} segundos',
  'app.saved': 'Salvo.',
  'app.saved_2': '{name} salvo.',
  'app.saved_it_applies_next_time': 'Salvo. Vale na próxima vez que o Harmony iniciar — reiniciar agora encerraria sua transmissão.',
  'app.saved_restart_harmony_to_apply': 'Salvo. Reinicie o Harmony para aplicar — clique aqui para reiniciar agora.',
  'app.saved_the_media_relay_keeps': 'Salvo. O relay de mídia mantém a configuração antiga até o servidor ser reiniciado.',
  'app.saving': 'Salvando…',
  'app.server_password': 'Senha do servidor',
  'app.server_password_not_needed': 'Senha do servidor (não necessária)',
  'app.set_hotkey': 'Definir atalho',
  'app.share_screen_here': 'Compartilhar tela aqui',
  'app.sharing_in': 'Compartilhando em {name}',
  'app.sharing_without_audio': 'Compartilhando sem áudio.',
  'app.show': 'Mostrar',
  'app.show_a_different_screen_or': 'Mostre outra tela ou janela sem encerrar a transmissão',
  'app.show_a_preview_of_what': 'Mostrar uma pré-visualização do que você está compartilhando',
  'app.show_preview': 'Mostrar pré-visualização',
  'app.show_this_one_big': 'Mostrar esta em tamanho grande',
  'app.sign_in': 'Entrar',
  'app.sign_in_first': 'Entre primeiro.',
  'app.sign_in_to_a_server': 'Entre em um servidor para ver os clipes do Soundpad dele.',
  'app.sign_out': 'Sair',
  'app.signed_in_as': 'Conectado como {name}.',
  'app.soundpad_clips': 'Clipes do Soundpad',
  'app.start_again_from_midnight': 'Recomeçar com Meia-noite',
  'app.start_camera': 'Ligar câmera',
  'app.start_streaming': 'Iniciar transmissão',
  'app.stop_camera': 'Desligar câmera',
  'app.stop_hearing_my_own_audio': 'Parar de ouvir meu próprio áudio',
  'app.stop_hearing_your_own_stream': 'Parar de ouvir sua própria transmissão',
  'app.stop_sharing': 'Parar de compartilhar',
  'app.stop_streaming': 'Parar transmissão',
  'app.stop_this_combination_doing_it': 'Impedir que esta combinação faça isso',
  'app.stop_this_combination_playing_the': 'Impedir que esta combinação toque o clipe',
  'app.stop_watching_this_and_stop': 'Parar de assistir e de baixar isto',
  'app.stream_ended': 'Transmissão encerrada',
  'app.stream_ended_waiting_for': 'Transmissão encerrada. Aguardando {username}…',
  'app.switching': 'Trocando…',
  'app.testing': 'Testando…',
  'app.text_channel': 'Canal de texto',
  'app.that_camera_cannot_do_that': 'Essa câmera não suporta essa qualidade. Voltando à configuração anterior.',
  'app.that_camera_could_not_be': 'Não foi possível abrir essa câmera. Continuando com a anterior.',
  'app.that_file_could_not_be': 'Não foi possível ler esse arquivo como imagem.',
  'app.that_image_is_too_detailed': 'Essa imagem tem detalhes demais para ser usada como logo.',
  'app.that_is_not_the_right': 'Esse não é o nome de usuário certo. Nada foi excluído.',
  'app.that_message_is_no_longer': 'Essa mensagem não está mais neste canal.',
  'app.that_microphone_could_not_be': 'Não foi possível abrir esse microfone. Continuando com o anterior.',
  'app.that_one_cannot_be_empty': 'Este campo não pode ficar vazio.',
  'app.that_one_was_not_right': 'Esse não estava certo.',
  'app.that_picture_is_too_detailed': 'Essa imagem tem detalhes demais para ser reduzida.',
  'app.that_picture_is_too_detailed_2': 'Essa imagem tem detalhes demais para ser reduzida a um emoji.',
  'app.that_source_was_not_allowed': 'Essa fonte não foi permitida.',
  'app.the_address_you_were_given': 'O endereço que você recebeu para o seu servidor Harmony.',
  'app.the_camera_could_not_be': 'Não foi possível reabrir a câmera. Desligue e ligue de novo.',
  'app.the_camera_could_not_be_2': 'Não foi possível abrir a câmera de novo para trocar o fundo.',
  'app.the_camera_stopped_turn_it': 'A câmera parou. Desligue e ligue de novo.',
  'app.the_channels_in_it_stay': 'Os canais dentro dele continuam',
  'app.the_channels_in_it_stay_2': 'Os canais dentro dele continuam e voltam para o topo da lista.',
  'app.the_original_message_was_deleted': 'A mensagem original foi excluída.',
  'app.the_server_never_saw_this': 'O servidor nunca viu esta transmissão entrar ao vivo. Talvez outra pessoa já esteja transmitindo com este nome.',
  'app.the_two_passwords_do_not': 'As duas senhas não coincidem.',
  'app.they_can_manage_channels_mute': 'Pode gerenciar canais, silenciar e mover pessoas',
  'app.they_go_back_to_being': 'A pessoa volta a ser um membro comum.',
  'app.this_build_cannot_choose_an': 'Esta versão não consegue escolher um dispositivo de saída; usando o padrão do sistema.',
  'app.this_channel_did_not_give': 'Este canal não forneceu um caminho de tela. Entre nele de novo.',
  'app.this_is_the_last_step': 'Este é o último passo.',
  'app.this_server': 'Este servidor',
  'app.this_server_asks_for_a': 'Este servidor pede uma senha antes de qualquer coisa.',
  'app.this_server_has_a_password': 'Este servidor tem uma senha. Deixe em branco para manter a atual.',
  'app.this_server_has_accounts_enter': 'Este servidor tem contas. Digite sua senha ou crie uma conta.',
  'app.this_server_has_no_password': 'Este servidor não tem senha. Digite uma aqui para começar a exigi-la.',
  'app.this_server_has_no_soundpad': 'Este servidor ainda não tem clipes no Soundpad. Eles aparecem aqui conforme são adicionados.',
  'app.this_session_expired_sign_in': 'Esta sessão expirou. Entre de novo.',
  'app.turn_your_camera_on_in': 'Ligue sua câmera em um canal de voz para vê-la aqui.',
  'app.type_to_confirm': 'Digite {nickname} para confirmar',
  'app.undeafen': 'Remover ensurdecimento',
  'app.unlocked': 'desbloqueado',
  'app.unmute': 'Ativar som',
  'app.unmute_everything': 'Ativar o som de tudo',
  'app.unmute_for_me': 'Ativar som para mim',
  'app.unmute_mic': 'Reativar microfone',
  'app.unmute_the_soundpad': 'Ativar o som do Soundpad',
  'app.unpin': 'Desafixar',
  'app.upload_cancelled': 'Envio cancelado.',
  'app.use_this_source': 'Usar esta fonte',
  'app.viewers_will_hear': 'Os espectadores vão ouvir {label}.',
  'app.viewers_will_hear_all_system': 'Os espectadores vão ouvir todo o áudio do sistema.',
  'app.viewers_will_hear_only_this': 'Os espectadores vão ouvir apenas este aplicativo.',
  'app.viewers_will_hear_system_audio': 'Os espectadores vão ouvir o áudio do sistema, exceto {name}.',
  'app.voice_channel': 'Canal de voz',
  'app.voice_connected': 'Voz conectada',
  'app.volume_for': 'Volume de {username}',
  'app.volume_for_this_share': 'Volume deste compartilhamento',
  'app.wait_for_the_file_already': 'Espere o envio do arquivo em andamento terminar.',
  'app.waiting_for_keys': 'Aguardando teclas…',
  'app.waiting_for_to_start_sharing': 'Aguardando {username} começar a compartilhar…',
  'app.watch_this_again': 'Assistir de novo',
  'app.watching': '{viewers} assistindo',
  'app.watching_2': 'Assistindo {username}',
  'app.will_encode_on_the_cpu': 'Vai codificar na CPU após reiniciar.',
  'app.will_use_the_gpu_again': 'Vai usar a GPU de novo após reiniciar.',
  'app.you_already_hear_this_audio': 'Você já ouve este áudio pelos seus alto-falantes',
  'app.you_are_live_restarting_now': 'Você está ao vivo. Reiniciar agora encerra sua transmissão; a atualização também é instalada quando você fechar o app.',
  'app.your_camera_path_is_already': 'O caminho da sua câmera já está em uso.',
  'app.your_chosen_camera_is_unplugged': 'A câmera que você escolheu está desconectada. Usando a padrão.',
  'app.your_display_name': 'Seu nome de exibição',
  'app.your_screen_share_lost_its': 'O compartilhamento da sua tela perdeu a conexão.',

  // --- ask_cancel
  'ask_cancel.cancel': 'Cancelar',

  // --- audio
  'audio.input_n': 'Entrada de áudio {n}',
  'audio.selected_input': 'a entrada selecionada',
  'audio.unavailable_all': 'Áudio por aplicativo indisponível — TODO o áudio do sistema será compartilhado. {reason}',
  'audio.unavailable_none': 'Áudio por aplicativo indisponível — compartilhando sem som. {reason}',

  // --- audio_input_field
  'audio_input_field.audio_input': 'Entrada de áudio',

  // --- background
  'background.file_too_big': 'Esse arquivo tem {size} MB. O limite é {limit} MB.',
  'background.the_camera_has_no_video': 'A câmera não tem vídeo para processar.',
  'background.webgl2_is_not_available': 'WebGL2 não está disponível.',

  // --- bg_group
  'bg_group.a_picture_or_a': 'Uma imagem ou um GIF, de até 25 MB. Fica neste computador.',
  'bg_group.background_colour': 'Cor de fundo',
  'bg_group.blur': 'Desfoque',
  'bg_group.camera_background': 'Fundo da câmera',
  'bg_group.colours': 'Cores',
  'bg_group.custom': 'Personalizado',
  'bg_group.direction': 'Direção',
  'bg_group.done_on_your_computer': 'Feito no seu computador antes de qualquer envio. Ninguém, nem o servidor, vê o que está atrás de você.',
  'bg_group.first_colour': 'Primeira cor',
  'bg_group.from': 'De',
  'bg_group.gradient_from': 'Gradiente de',
  'bg_group.gradient_to': 'Gradiente até',
  'bg_group.gradients': 'Gradientes',
  'bg_group.pick_any_colour': 'Escolha qualquer cor',
  'bg_group.second_colour': 'Segunda cor',
  'bg_group.to': 'Até',

  // --- bg_mode
  'bg_mode.blur': 'Desfoque',
  'bg_mode.colour': 'Cor',
  'bg_mode.gradient': 'Gradiente',
  'bg_mode.image': 'Imagem',
  'bg_mode.none': 'Nenhum',

  // --- bg_remove
  'bg_remove.remove': 'Remover',

  // --- broadcast_clip
  'broadcast_clip.clip': '✂ Clipe',

  // --- broadcast_watch
  'broadcast_watch.watch_others': 'Ver outras',

  // --- change_source
  'change_source.change_source': 'Alterar fonte',

  // --- channel_dock
  'channel_dock.change_your_display_name': 'Altere seu nome de exibição',
  'channel_dock.change_your_picture': 'Altere sua foto',
  'channel_dock.devices_and_appearance': 'Dispositivos e aparência',

  // --- channels
  'channels.mentions': { one: '{count} mensagem menciona você', other: '{count} mensagens mencionam você' },

  // --- chat
  'chat.drop_title': 'Solte para enviar em #{name}',
  'chat.results': { one: '{count} resultado ({mode})', other: '{count} resultados ({mode})' },
  'chat.this_channel': 'este canal',

  // --- chat_active
  'chat_active.search_messages_people_or': 'Buscar mensagens, pessoas ou mídia',

  // --- chat_attach
  'chat_attach.attach': 'Anexar',

  // --- chat_drop
  'chat_drop.one_file_per_message': 'Um arquivo por mensagem. Ele está anexado, pronto para enviar.',

  // --- chat_emoji
  'chat_emoji.emoji': 'Emoji',

  // --- chat_form
  'chat_form.attach_a_file': 'Anexar um arquivo',
  'chat_form.emoji': 'Emoji',
  'chat_form.message': 'Mensagem',
  'chat_form.send': 'Enviar',

  // --- chat_pending
  'chat_pending.don_t_send_this': 'Não enviar isto',

  // --- chat_pending_clear
  'chat_pending_clear.remove': 'Remover',

  // --- chat_reply
  'chat_reply.cancel_the_reply': 'Cancelar a resposta',
  'chat_reply.replying_to': 'Respondendo a',

  // --- chat_reply_clear
  'chat_reply_clear.cancel_reply': 'Cancelar resposta',

  // --- chat_search_clear
  'chat_search_clear.clear': 'Limpar',

  // --- chat_send
  'chat_send.send': 'Enviar',

  // --- chat_upload
  'chat_upload.cancel_the_upload': 'Cancelar o envio',
  'chat_upload.upload_progress': 'Progresso do envio',

  // --- chat_upload_cancel
  'chat_upload_cancel.cancel_upload': 'Cancelar envio',

  // --- clip
  'clip.could_not_read_the_video': 'Não foi possível ler os parâmetros de vídeo desta transmissão.',
  'clip.no_keyframe_buffered_yet_give': 'Nenhum quadro-chave no buffer ainda; espere alguns segundos.',

  // --- comp
  'comp.add_a_screen_window_or': 'Adicionar uma tela, janela ou câmera…',
  'comp.add_a_source': 'Adicionar uma fonte',
  'comp.add_source': '+ Adicionar fonte',
  'comp.bring_to_front': 'Trazer para a frente',
  'comp.could_not_add': 'Não foi possível adicionar {name}: {message}',
  'comp.crop': 'Cortar',
  'comp.cropping': 'Cortando {name}',
  'comp.done': 'Concluir',
  'comp.empty_hint': 'Clique com o botão direito para adicionar uma tela, janela ou câmera.',
  'comp.fill_canvas': 'Preencher a tela',
  'comp.finish_cropping': 'Concluir corte',
  'comp.finish_free_resize': 'Concluir redimensionamento livre',
  'comp.fit_to_canvas': 'Ajustar à tela',
  'comp.free_resize': 'Redimensionamento livre: {name}',
  'comp.free_resize_stretch': 'Redimensionamento livre (esticar)',
  'comp.hint': 'Ao vivo enquanto você edita. Arraste para mover, arraste um canto para redimensionar, clique com o botão direito para mais opções.',
  'comp.looking': 'Procurando fontes…',
  'comp.nothing_to_add': 'Nada para adicionar.',
  'comp.original_size_1_1': 'Tamanho original (1:1)',
  'comp.remove': 'Remover {name}',
  'comp.reset_crop': 'Redefinir corte',
  'comp.send_to_back': 'Enviar para trás',
  'comp.size_25_of_the_width': 'Tamanho: 25% da largura',
  'comp.size_50_of_the_width': 'Tamanho: 50% da largura',
  'comp.size_75_of_the_width': 'Tamanho: 75% da largura',
  'comp.title': 'Composição',

  // --- connect
  'connect.enter_address': 'Digite o endereço do seu servidor Harmony.',
  'connect.not_answering': '{host} não está respondendo. Verifique se ele está em execução ou escolha outro servidor.',
  'connect.owner_key_refused': 'Essa chave de dono não foi aceita, então esta conta é um membro comum.',
  'connect.pick_username': 'Escolha um nome de usuário.',
  'connect.username_hint_login': 'O nome de usuário com o qual você se registrou.',
  'connect.username_hint_new': 'Este será seu nome permanente. De 2 a 20 caracteres, e é como sua transmissão vai se chamar.',
  'connect.username_hint_stream': 'Nome livre → você inicia a transmissão. Nome já ao vivo → você entra e assiste.',
  'connect.wrong_password': 'Senha do servidor incorreta.',

  // --- devices
  'devices.camera': 'câmera',
  'devices.microphone': 'microfone',
  'devices.output': 'saída',
  'devices.unplugged': { one: 'O dispositivo escolhido ({what}) foi desconectado. Usando o padrão do sistema até ele voltar.', other: 'Os dispositivos escolhidos ({what}) foram desconectados. Usando o padrão do sistema até eles voltarem.' },

  // --- devices_close
  'devices_close.done': 'Concluir',

  // --- diag
  'diag.connected': 'conectado',
  'diag.connection_test': 'Teste de conexão',
  'diag.got_role': 'recebeu {role}',
  'diag.no_path': 'nenhum caminho de rede funcional foi encontrado',
  'diag.none': 'nenhum',
  'diag.signaling_on': 'sinalização em {address}',
  'diag.step_exchange': 'Trocar dados da conexão',
  'diag.step_media': 'O servidor de mídia está em execução',
  'diag.step_reach': 'Alcançar o servidor Harmony',
  'diag.step_reserve': 'Reservar um nome de teste',
  'diag.step_send': 'Enviar vídeo ao servidor',
  'diag.step_stun': 'Descobrir seu endereço público (STUN)',
  'diag.step_test': 'Teste de conexão',
  'diag.stun_not_needed': 'não necessário: este servidor não oferece STUN',
  'diag.stun_only': 'apenas {types} — o UDP pode estar bloqueado',
  'diag.verdict_blocked_ports': 'A sinalização funciona, mas a mídia não consegue passar. Sua rede está bloqueando as portas de mídia. Seria preciso um relay TURN.',
  'diag.verdict_media_down': 'O servidor está no ar, mas o servidor de mídia não. É um problema do lado do servidor.',
  'diag.verdict_ok': 'Tudo funcionando. Transmitir e assistir devem funcionar bem nesta rede.',
  'diag.verdict_reserve': 'Não foi possível reservar um nome temporário; tente de novo em instantes.',
  'diag.verdict_stopped': 'O teste parou antes do fim: {message}',
  'diag.verdict_tcp': 'Funcionando, pelo TCP de reserva. Espere um atraso maior que o normal, mas vai transmitir.',
  'diag.verdict_udp_blocked': 'O UDP parece estar bloqueado na sua rede. O servidor também oferece um caminho TCP; se ainda assim falhar, seria preciso um relay TURN.',
  'diag.verdict_unreachable': 'Não foi possível alcançar o servidor. Verifique o endereço e se sua rede permite esta porta.',

  // --- diag_close
  'diag_close.close': 'Fechar',

  // --- download
  'download.progress': 'Baixando {name}… {percent}% ({received} de {total})',

  // --- edit_composition
  'edit_composition.edit_layout': 'Editar layout',

  // --- emoji
  'emoji.name_hint': 'O nome é o gatilho: digitá-lo entre dois-pontos coloca a imagem em uma mensagem. Letras, números e sublinhados.',

  // --- emoji_add
  'emoji_add.add': '+ Adicionar',

  // --- emoji_pop
  'emoji_pop.search_emoji': 'Buscar emoji',
  'emoji_pop.upload_a_custom_emoji': 'Enviar um emoji personalizado',

  // --- exclude_field
  'exclude_field.exclude_audio': 'Excluir áudio',

  // --- fallback_field
  'fallback_field.if_per_app_audio': 'Se o áudio por aplicativo estiver indisponível',

  // --- gpu
  'gpu.current': 'Atualmente em {active}, de {all}. Deixe como está, a menos que esteja resolvendo um problema: a GPU dedicada normalmente é a melhor escolha, porque é onde o jogo capturado já está rodando.',
  'gpu.hint': 'Esta máquina tem duas GPUs ({all}). Se sua tela está ligada à integrada, cada quadro que o Harmony desenha é copiado entre as GPUs antes de chegar ao monitor, o que custa cerca de 10% da máquina enquanto você transmite. Procure uma chave MUX, NVIDIA Advanced Optimus ou uma opção de "modo de exibição" no utilitário do fabricante do seu notebook, e aponte o painel para a GPU dedicada. Vale fazer uma vez — é a maior melhoria que você pode fazer.',
  'gpu.on_both': 'Ativado — sua GPU está codificando e decodificando. NVENC, AMF ou Quick Sync, o que seu driver oferecer.',
  'gpu.on_encode': 'Ativado — sua GPU está codificando. NVENC, AMF ou Quick Sync, o que seu driver oferecer.',
  'gpu.unknown': 'uma GPU desconhecida',

  // --- gpu_preference
  'gpu_preference.the_dedicated_gpu_normally': 'A GPU dedicada — normalmente a melhor',
  'gpu_preference.the_integrated_gpu': 'A GPU integrada',
  'gpu_preference.whichever_gpu_windows_picks': 'A GPU que o Windows escolher',

  // --- gpu_preference_field
  'gpu_preference_field.run_harmony_on': 'Executar o Harmony em',

  // --- hotkey_recorder
  'hotkey_recorder.press_the_combination_you': 'Pressione a combinação desejada. Esc cancela.',

  // --- hotkey_recorder_cancel
  'hotkey_recorder_cancel.cancel': 'Cancelar',

  // --- hotkey_recorder_clear
  'hotkey_recorder_clear.remove_hotkey': 'Remover atalho',

  // --- hotkeys
  'hotkeys.bad_key': 'Essa tecla não pode ser usada como atalho.',
  'hotkeys.camera': 'Ligar / desligar a câmera',
  'hotkeys.deafen': 'Ensurdecer / remover ensurdecimento',
  'hotkeys.err_duplicate': 'Também está associado a outra coisa.',
  'hotkeys.err_in_use': 'Outro programa já usa essa combinação. Escolha outra.',
  'hotkeys.err_invalid': 'Não é uma combinação que o Windows consegue registrar.',
  'hotkeys.join_first': 'Entre em um canal de voz primeiro: este atalho funciona dentro de uma chamada.',
  'hotkeys.mac_option': 'O macOS não entrega atalhos com Option a um app em segundo plano. Adicione Command ou Control.',
  'hotkeys.mute': 'Silenciar / reativar microfone',
  'hotkeys.needs_modifier': 'Adicione Ctrl ou Alt. Sozinha, essa tecla deixaria de funcionar em todos os outros programas enquanto o Harmony estiver aberto.',
  'hotkeys.not_registered': 'não foi possível registrar.',

  // --- leave_stream
  'leave_stream.leave': 'Sair',

  // --- lightbox
  'lightbox.close': 'Fechar',
  'lightbox.save_a_copy': 'Salvar uma cópia',

  // --- lightbox_close
  'lightbox_close.close': 'Fechar',

  // --- lightbox_save
  'lightbox_save.save': 'Salvar',

  // --- limit
  'limit.bandwidth': 'limitado pela sua velocidade de envio',
  'limit.cpu': 'limitado por este computador',
  'limit.other': 'limitado',

  // --- live_list
  'live_list.live_now': 'Ao vivo agora',

  // --- main
  'main.deafen': 'Ensurdecer',
  'main.deafened': 'ensurdecido',
  'main.disconnect': 'Desconectar',
  'main.mute': 'Silenciar',
  'main.muted': 'silenciado',
  'main.open': 'Abrir o Harmony',
  'main.quit': 'Sair do Harmony',
  'main.save_attachment': 'Salvar anexo',
  'main.still_running': 'O Harmony continua em execução',
  'main.still_running_balloon': 'Ele continua aqui embaixo, chamadas incluídas. Clique com o botão direito neste ícone para sair.',
  'main.still_running_notice': 'Ele continua na bandeja, chamadas incluídas. Clique com o botão direito no ícone para sair.',
  'main.undeafen': 'Remover ensurdecimento',
  'main.unmute': 'Ativar som',

  // --- member_list
  'member_list.members': 'Membros',
  'member_list.resize_the_member_list': 'Redimensionar a lista de membros',

  // --- members
  'members.delete_hint': 'Remove a pessoa e tudo que ela escreveu',
  'members.move': 'Mover…',
  'members.offline': 'Offline — {count}',
  'members.online': 'Online — {count}',

  // --- mosaic
  'mosaic.nobody': 'Ninguém está transmitindo agora.',
  'mosaic.none_live': 'Nenhuma das transmissões escolhidas está ao vivo.',
  'mosaic.none_open': 'Nenhuma transmissão aberta. Use + Adicionar transmissão para trazer uma de volta.',

  // --- mosaic_add
  'mosaic_add.add_stream': '+ Adicionar transmissão',

  // --- mosaic_hint
  'mosaic_hint.each_tile_has_its': 'Cada bloco tem seu próprio volume. ⤢ maximiza, ⛶ ou clique duplo abre em tela cheia, ✕ fecha.',

  // --- nav
  'nav.back_to_channels': 'Voltar aos canais',
  'nav.back_to_stream': 'Voltar à minha transmissão',
  'nav.leave': 'Sair',

  // --- owner_key_field
  'owner_key_field.owner_key': 'Chave de dono',
  'owner_key_field.printed_in_the_server': 'Exibida no log do servidor na primeira inicialização',

  // --- password_field
  'password_field.server_password': 'Senha do servidor',
  'password_field.this_server_asks_for': 'Este servidor pede uma',

  // --- picker
  'picker.cameras_capture_cards': 'Câmeras e placas de captura',
  'picker.choose_what_to_share': 'Escolha o que compartilhar',
  'picker.compose_hint': 'Escolha quantas quiser para começar, ou nenhuma. Depois de entrar ao vivo, você pode adicionar, mover, redimensionar e cortar: clique com o botão direito na pré-visualização.',
  'picker.composite': 'Composição',
  'picker.framerate': 'Taxa de quadros',
  'picker.loading': 'Carregando…',
  'picker.look_for_sources_again': 'Procurar fontes de novo',
  'picker.none_cameras': 'Nenhuma câmera ou placa de captura encontrada.',
  'picker.none_screen': 'Nenhuma tela encontrada.',
  'picker.none_window': 'Nenhuma janela encontrada.',
  'picker.resolution': 'Resolução',
  'picker.screens': 'Telas',
  'picker.source_type': 'Tipo de fonte',
  'picker.sources': 'Fontes',
  'picker.streaming_as': 'Transmitindo como',
  'picker.windows': 'Janelas',

  // --- picker_refresh
  'picker_refresh.refresh': 'Atualizar',

  // --- preview
  'preview.hidden_text': 'Você continua ao vivo. Desenhar a pré-visualização gasta GPU além do jogo que você está compartilhando, então ocultá-la é desempenho de graça.',
  'preview.paused_text': 'Você continua ao vivo. O Harmony não está desenhando a pré-visualização enquanto a janela está minimizada, porque ninguém a veria — seria trabalho desperdiçado.',

  // --- priority
  'priority.sharp': 'Nítida — manter a resolução',
  'priority.smooth': 'Fluida — manter a taxa de quadros',

  // --- privacy
  'privacy.hide': 'Ocultar seus dados',
  'privacy.show': 'Mostrar seus dados',

  // --- profile
  'profile.back_to_username': 'De volta ao seu nome de usuário.',
  'profile.banner_changed': 'Banner alterado.',
  'profile.banner_removed': 'Banner removido.',
  'profile.banner_too_big': 'Esse banner tem mais de 2 MB. Escolha um GIF menor ou uma imagem estática, que é reduzida para você.',
  'profile.font_default': 'Padrão',
  'profile.font_saved': 'Fonte alterada.',
  'profile.join_sound_changed': 'Som de entrada definido ({seconds} segundos).',
  'profile.join_sound_custom': 'Seu próprio som',
  'profile.join_sound_default': 'O toque padrão',
  'profile.join_sound_removed': 'De volta ao toque padrão.',
  'profile.join_sound_too_big': 'Esse arquivo é grande demais. Escolha um com menos de 20 MB.',
  'profile.join_sound_trimmed': 'Som de entrada definido. Ele tinha mais de {seconds} segundos, então foi cortado nesse ponto.',
  'profile.join_sound_unreadable': 'Não foi possível ler isso como áudio.',
  'profile.name_dialog_text': 'Exibido para todos neste servidor. Deixe em branco para voltar a "{nickname}". Maiúsculas, espaços e acentos são permitidos.',
  'profile.picture_changed': 'Foto alterada.',
  'profile.picture_removed': 'Foto removida.',
  'profile.saved': 'Salvo.',

  // --- profile_choose
  'profile_banner.choose_banner': 'Escolher banner',
  'profile_banner.remove_banner': 'Remover banner',
  'profile_choose.change_picture': 'Alterar foto',

  // --- profile_name_reset
  'profile_name_reset.use_my_username': 'Usar meu nome de usuário',

  // --- profile_name_save
  'profile_name_save.save': 'Salvar',

  // --- profile_remove
  'profile_remove.remove_picture': 'Remover foto',

  // --- quality
  'profile_sound.choose_sound': 'Escolher som',
  'profile_sound.play': 'Ouvir',
  'profile_sound.remove_sound': 'Remover',
  'ptt.record_title': 'Tecla de aperte para falar',
  'ptt.reset_done': 'Redefinido. O Harmony está reiniciando; permita quando o macOS perguntar.',
  'ptt.reset_failed': 'Não foi possível redefinir por aqui. Em Ajustes do Sistema, selecione o Harmony na lista de Acessibilidade e pressione o botão de menos; depois reinicie o Harmony.',
  'ptt.scope_global': 'Funciona em qualquer aplicativo enquanto você está em um canal de voz.',
  'ptt.scope_no_key': 'Escolha uma tecla. Qualquer tecla ou combinação serve, e ela não é tirada dos outros programas.',
  'ptt.scope_permission': 'O macOS não permitiu que o Harmony veja teclas em outros aplicativos, então por enquanto só funciona com o Harmony na frente. Ative o Harmony em Ajustes do Sistema → Privacidade e Segurança → Acessibilidade e depois desligue e ligue o aperte para falar.',
  'ptt.scope_unavailable': 'Este computador não deixa o Harmony observar teclas em outros aplicativos, então só funciona com a janela do Harmony na frente.',
  'ptt.scope_window': 'Funciona enquanto o Harmony é a janela da frente.',
  'ptt.status_talking': 'Falando',
  'ptt.status_waiting': 'Aperte para falar',
  'quality.fps': '{fps} fps',
  'quality.native': 'Nativa',
  'quality.note_heavy': 'Qualidade maior usa mais banda e mais recursos deste computador, e o fundo da câmera tem mais trabalho com uma imagem maior.',
  'quality.note_live': 'Vale na hora para uma câmera em uso.',
  'quality.note_native': 'Nativa pede à câmera o máximo que ela oferece, e a imagem enviada acompanha.',

  // --- roles
  'roles.admin': 'admin',
  'roles.member': 'membro',
  'roles.owner': 'dono',

  // --- scale_reset
  'scale_reset.reset': 'Redefinir',

  // --- server
  'screen_permission.body': 'O macOS não permitiu a Gravação de Tela para o Harmony. Ative-a em Ajustes do Sistema e reinicie o Harmony. Se já estiver ativada e isso continuar aparecendo, a chave pertence a uma cópia antiga do app: use "Redefinir e reiniciar" e depois permita quando o macOS perguntar.',
  'screen_permission.open_settings': 'Abrir Ajustes do Sistema',
  'screen_permission.reset': 'Redefinir e reiniciar',
  'screen_permission.reset_failed': 'Não foi possível redefinir por aqui. Em Ajustes do Sistema, selecione o Harmony na lista, pressione o botão de menos, reinicie o Harmony e compartilhe de novo.',
  'screen_permission.restart': 'Reiniciar o Harmony',
  'screen_permission.title': 'O Harmony ainda não consegue ver a sua tela',
  'server.storage_note': '{used} em uso · {free} livres no disco do servidor. Arquivos antigos que ninguém mais usa são apagados para abrir espaço.',
  'server.storage_note_short': '{used} em uso. Arquivos antigos que ninguém mais usa são apagados para abrir espaço.',

  // --- server_add
  'server_add.add_a_server': '+ Adicionar servidor',

  // --- server_back
  'server_back.back_to_my_servers': 'Voltar aos meus servidores',

  // --- server_cancel
  'server_cancel.cancel': 'Cancelar',

  // --- server_form
  'server_form.anybody_who_can_reach': 'Qualquer pessoa que consiga acessar este servidor pode usá-lo.',
  'server_form.leave_blank_to_keep': 'Deixe em branco para manter como está',
  'server_form.logo': 'Logo',
  'server_form.name': 'Nome',
  'server_form.no_password_at_all': 'Nenhuma senha',
  'server_form.password': 'Senha',
  'server_form.shown_in_everybody_s': 'Exibido na lista de servidores de todos. Quadrada funciona melhor; é reduzida para 256 px.',
  'server_form.this_server': 'Este servidor',
  'server_form.what_it_is_called': 'Como ele se chama na barra de título, para todos.',

  // --- server_logo_pick
  'server_logo_pick.choose_image': 'Escolher imagem…',

  // --- server_logo_remove
  'server_logo_remove.remove': 'Remover',

  // --- server_max_file
  'server_max_file.100_mb': '100 MB',
  'server_max_file.1_gb': '1 GB',
  'server_max_file.250_mb': '250 MB',
  'server_max_file.25_mb': '25 MB',
  'server_max_file.2_gb': '2 GB',
  'server_max_file.500_mb': '500 MB',
  'server_max_file.50_mb': '50 MB',
  'server_max_file.8_mb': '8 MB',

  // --- server_menu
  'server_menu.search_servers': 'Buscar servidores',

  // --- server_options_empty
  'server_options_empty.no_servers_match': 'Nenhum servidor encontrado.',

  // --- server_save
  'server_save.save': 'Salvar',

  // --- server_uploads
  'server_uploads.largest_file': 'Maior arquivo',
  'server_uploads.space_for_files_gb': 'Espaço para arquivos (GB)',
  'server_uploads.the_biggest_file_anybody': 'O maior arquivo que qualquer pessoa pode enviar em um chat.',

  // --- session
  'session.account_removed': 'Sua conta foi removida deste servidor.',
  'session.disconnected': 'Desconectado: {reason}',

  // --- settings
  'settings.appearance': 'Aparência',
  'settings.appearance.appearance': 'Aparência',
  'settings.appearance.bigger': 'Maior',
  'settings.appearance.colour_palette': 'Paleta de cores',
  'settings.appearance.everything_at_once_the': 'Tudo de uma vez: texto, ícones, imagens e o espaçamento entre eles. É o zoom da própria janela, então um valor maior cabe menos coisa na tela.',
  'settings.appearance.interface_size': 'Tamanho da interface',
  'settings.appearance.smaller': 'Menor',
  'settings.appearance.yours_alone_nothing_is': 'Só seu. Nada é enviado ao servidor, e duas pessoas no mesmo canal podem estar vendo cores diferentes.',
  'settings.hotkeys': 'Atalhos',
  'settings.hotkeys.hotkeys': 'Atalhos',
  'settings.hotkeys.work_anywhere_even_while': 'Funcionam em qualquer lugar, mesmo com um jogo em foco. Uma combinação definida aqui é tirada de todos os outros programas enquanto o Harmony estiver aberto, então use um modificador (Ctrl, Alt, Shift) ou uma tecla F. Todos os clipes do Soundpad deste servidor estão listados abaixo; clicar com o botão direito em um clipe no Soundpad faz o mesmo.',
  'settings.language.auto': 'Automático ({language})',
  'settings.language.note': 'O idioma dos menus e das mensagens deste app. Cada pessoa no mesmo servidor pode usar o seu; o que é escrito no chat continua como foi escrito.',
  'settings.language.title': 'Idioma',
  'settings.profile': 'Perfil',
  'settings.profile.account': 'Conta',
  'settings.profile.banner': 'Banner',
  'settings.profile.banner_note': 'Aparece atrás do seu nome na lista de membros e nos canais de voz, escurecido e esmaecendo para a esquerda. Uma imagem ou um GIF, de até 2 MB; uma imagem estática é reduzida para caber.',
  'settings.profile.display_name': 'Nome de exibição',
  'settings.profile.join_sound': 'Som de entrada',
  'settings.profile.join_sound_note': 'Tocado para as pessoas em um canal de voz quando você entra, no lugar do toque padrão. Até 10 segundos: o que passar disso é cortado em 10. Qualquer arquivo de áudio que o seu computador reproduza serve.',
  'settings.profile.name_font': 'Fonte do nome',
  'settings.profile.name_font_note': 'Como o seu nome de exibição é desenhado para todos neste servidor. As fontes vêm com o app, então todos veem a mesma.',
  'settings.profile.picture': 'Foto',
  'settings.profile.profile': 'Perfil',
  'settings.profile.role': 'Cargo',
  'settings.profile.shown_to_everybody_instead': 'Exibido para todos no lugar do seu nome de usuário. Maiúsculas, espaços e acentos são permitidos, e duas pessoas podem escolher o mesmo. Em branco, volta ao seu nome de usuário.',
  'settings.profile.shown_to_everybody_on': 'Exibida para todos neste servidor, recortada em círculo. Qualquer imagem serve; ela é reduzida a um quadrado pequeno antes de ser enviada. Sem foto, suas iniciais são desenhadas no lugar.',
  'settings.profile.username': 'Nome de usuário',
  'settings.profile.your_username_is_what': 'Seu nome de usuário é o que você usa para entrar e o que as pessoas @mencionam. Ele não muda.',
  'settings.settings': 'Configurações',
  'settings.sounds': 'Sons',
  'settings.sounds.members_join_sounds': 'Sons de entrada dos membros',
  'settings.sounds.members_join_sounds_hint': 'Quando alguém que escolheu o próprio som de entrada entra no seu canal de voz, você ouve o dele no lugar do toque padrão. Desativado toca o toque padrão para todos.',
  'settings.sounds.mention_sound': 'Som de menção',
  'settings.sounds.sound_effects_volume': 'Volume dos efeitos sonoros',
  'settings.sounds.sounds': 'Sons',
  'settings.sounds.three_rising_notes_when': 'Três notas ascendentes quando alguém escreve seu nome, e o único aviso que toca para um canal que você não está vendo.',
  'settings.sounds.voice_channel_sounds': 'Sons do canal de voz',
  'settings.sounds.when_you_or_somebody': 'Quando você ou outra pessoa entra ou sai, uma transmissão começa ou termina, e quando você silencia ou ensurdece. Ascendente significa ligado, descendente significa desligado.',
  'settings.updates': 'Atualizações',
  'settings.updates.updates': 'Atualizações',
  'settings.voice.camera': 'Câmera',
  'settings.voice.camera_quality': 'Qualidade da câmera',
  'settings.voice.devices': 'Dispositivos',
  'settings.voice.echo_cancellation': 'Cancelamento de eco',
  'settings.voice.echo_cancellation_hint': 'Impede que o som dos seus alto-falantes seja captado pelo microfone. Útil sem fones de ouvido; pode fazer sua voz diminuir enquanto algum som está tocando.',
  'settings.voice.frame_rate': 'Taxa de quadros',
  'settings.voice.input_sensitivity': 'Sensibilidade de entrada',
  'settings.voice.input_volume': 'Volume de entrada',
  'settings.voice.microphone': 'Microfone',
  'settings.voice.noise_suppression': 'Supressão de ruído',
  'settings.voice.noise_suppression_hint': 'Filtra ruídos constantes de fundo, como ventiladores e teclados. Pode cortar o final das palavras.',
  'settings.voice.output': 'Saída',
  'settings.voice.push_to_talk': 'Aperte para falar',
  'settings.voice.push_to_talk_hint': 'Seu microfone fica em silêncio até você segurar a tecla escolhida. Silenciar continua valendo.',
  'settings.voice.push_to_talk_key': 'Tecla de aperte para falar',
  'settings.voice.resolution': 'Resolução',
  'settings.voice.speak_normally_put_the': 'Fale normalmente. Coloque o marcador um pouco acima de onde a barra fica quando você está em silêncio, e abaixo de onde ela fica quando você fala.',
  'settings.voice.voice_video': 'Voz e vídeo',
  'settings.voice_video': 'Voz e vídeo',

  // --- share
  'share.capture_blocked': 'A captura de tela foi bloqueada.',

  // --- soundpad
  'share.capture_blocked_mac': 'O macOS bloqueou a captura de tela. Abra o seletor de fontes e siga o aviso no topo: se o Harmony já estiver ativado em Gravação de Tela e Áudio do Sistema, use "Redefinir e reiniciar".',
  'soundpad.emoji_hint': 'O emoji é opcional, e é o que ajuda a achar um clipe numa grade de vinte botões idênticos.',
  'soundpad.find_the_perfect_sound': 'Encontre o som perfeito',
  'soundpad.how_loudly_soundpad_clips': 'Quão alto os clipes do Soundpad tocam para você',
  'soundpad.too_big': '"{name}" tem {size} MB. Os clipes são limitados a {limit} MB -- todo cliente baixa todos os clipes.',

  // --- soundpad_add
  'soundpad_add.add': '+ Adicionar',

  // --- stats
  'stats.encode': 'codificação {ms} ms',
  'stats.link': 'link {mbps} Mbps',

  // --- status
  'status.cam': 'câmera ligada',
  'status.deaf': 'ensurdecido -- não ouve ninguém',
  'status.forced': 'silenciado por um admin',
  'status.muted': 'se silenciou',
  'status.screen': 'compartilhando a tela',

  // --- step_account
  'step_account.server': 'Servidor',

  // --- step_server
  'step_server.https_harmony_example_com': 'https://harmony.example.com ou 192.168.1.50:8080',
  'step_server.server_address': 'Endereço do servidor',

  // --- stop_stream
  'stop_stream.stop_streaming': 'Parar transmissão',

  // --- test_connection
  'test_connection.test_my_connection': 'Testar minha conexão',

  // --- theme
  'theme.accent': 'Destaque',
  'theme.background': 'Fundo',
  'theme.dark': 'Escuro',
  'theme.daylight': 'Luz do dia',
  'theme.ember': 'Brasa',
  'theme.forest': 'Floresta',
  'theme.lavender': 'Lavanda',
  'theme.midnight': 'Meia-noite',
  'theme.ocean': 'Oceano',
  'theme.onyx': 'Ônix',
  'theme.panels': 'Painéis',
  'theme.text': 'Texto',

  // --- toast
  'toast.click_to_show': '(clique para mostrar)',

  // --- update_check
  'update_check.check_now': 'Verificar agora',

  // --- updates
  'updates.available': 'A versão {version} está disponível.',
  'updates.checking': 'Verificando atualizações…',
  'updates.downloading': 'Baixando {version}… {percent}%',
  'updates.downloading_banner': 'Baixando o Harmony {version}… {percent}%',
  'updates.error': 'Não foi possível atualizar: {message}',
  'updates.idle': 'Ainda não verificado.',
  'updates.latest': 'Tudo atualizado.',
  'updates.open_page': 'Abrir página de download',
  'updates.ready': 'A versão {version} está pronta. Ela é instalada quando você reiniciar ou fechar o app.',
  'updates.restart_now': 'Reiniciar agora',
  'updates.unsupported_appimage': 'Só a versão AppImage se atualiza sozinha.',
  'updates.unsupported_development': 'As atualizações valem para uma versão instalada, não para uma execução de desenvolvimento.',

  // --- upload
  'upload.progress': '{percent}% · {sent} de {total}',

  // --- view
  'view.broadcast.framerate': 'Taxa de quadros',
  'view.broadcast.priority': 'Prioridade',
  'view.broadcast.resolution': 'Resolução',
  'view.broadcast.stop_drawing_the_preview': 'Parar de desenhar a pré-visualização — a transmissão continua',
  'view.channels.channels': 'Canais',
  'view.channels.create_a_channel': 'Criar um canal',
  'view.channels.members': 'Membros',
  'view.channels.resize_the_channel_list': 'Redimensionar a lista de canais',
  'view.channels.server_settings': 'Configurações do servidor',
  'view.channels.show_or_hide_the': 'Mostrar ou ocultar a lista de membros',
  'view.channels.sign_out': 'Sair',
  'view.connect.buffers_already_compressed_video': 'Mantém vídeo já comprimido na memória, então usa pouca CPU. Cerca de 30 MB por transmissão em 1080p.',
  'view.connect.encode_on_the_gpu': 'Codificar na GPU',
  'view.connect.harmony': 'Harmony',
  'view.connect.keep_the_last_30': 'Guardar os últimos 30 segundos para clipes',
  'view.connect.options': 'Opções',
  'view.connect.self_hosted_voice_video': 'Voz, vídeo e chat auto-hospedados para a sua própria comunidade',
  'view.mosaic.all_volumes': 'Todos os volumes',
  'view.mosaic.mosaic': 'Mosaico',

  // --- voice
  'voice.measuring': 'Medindo…',
  'voice.ms_to_relay': '{ms} ms até o relay',
  'voice.reconnecting': 'Reconectando…',

  // --- voice_config
  'voice_config.devices': 'Dispositivos',

  // --- voice_flip
  'voice_flip.switch_camera': 'Trocar câmera',

  // --- voice_idle
  'voice_idle.pick_a_voice_channel': 'Escolha um canal de voz para entrar.',

  // --- voice_leave
  'voice_leave.disconnect': 'Desconectar',

  // --- voice_panel
  'voice_panel.disconnect': 'Desconectar',
  'voice_panel.soundboard': 'Soundpad',
  'voice_panel.switch_camera': 'Trocar câmera',

  // --- voice_soundboard
  'voice_soundboard.soundboard': 'Soundpad',

  // --- watch_add
  'watch_add.add_stream': '+ Adicionar transmissão',

  // --- watch_all
  'watch_all.watch_all': 'Ver todas',

  // --- watch_clip
  'watch_clip.clip': '✂ Clipe',

  // --- window_audio_fallback
  'window_audio_fallback.share_silently': 'Compartilhar sem som',
  'window_audio_fallback.use_system_audio': 'Usar áudio do sistema',
};
