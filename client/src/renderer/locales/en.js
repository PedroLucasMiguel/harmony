// English: the language every string is written in first, and the one a
// missing key in any other language falls back to.
//
// A flat object of key -> text. Keys are grouped by the part of the app they
// belong to (the text before the first dot); a value is a string, or an object
// of plural forms picked by `count` -- see i18n.js.
//
// {name} marks where a value goes in. Keep those exactly as they are in every
// translation: the code fills them by name, so they may move within the
// sentence but may not be renamed or dropped.
//
// To add a language, copy this file, translate the values and leave the keys.
// README.md, "Translating".

export default {

  // --- account
  'account.delete_details': 'Their account and every message they have ever written are removed from the server. Pinned messages and attachments go with them. This cannot be undone.',
  'account.removed': { one: '{who} removed, with {count} message.', other: '{who} removed, with {count} messages.' },

  // --- account_confirm_field
  'account_confirm_field.confirm_password': 'Confirm password',

  // --- account_fields
  'account_fields.remember_me': 'Remember me',
  'account_fields.username': 'Username',
  'account_fields.your_name': 'your-name',

  // --- add_stream
  'add_stream.add_a_stream': 'Add a stream',

  // --- add_stream_close
  'add_stream_close.cancel': 'Cancel',

  // --- add_stream_empty
  'add_stream_empty.no_other_streams_are': 'No other streams are live right now.',

  // --- admin
  'admin.promote_details': 'They will be able to create and delete channels, force-mute and move anybody, and delete anybody\'s messages. Only you can take it back.',

  // --- app
  'app.a_composition_is_shared_without': 'A composition is shared without sound on this machine.',
  'app.add': 'Add',
  'app.add_a_reaction': 'Add a reaction',
  'app.already_registered': 'Already registered?',
  'app.an_admin_muted_your_microphone': 'An admin muted your microphone.',
  'app.at_least_6_characters': 'At least 6 characters',
  'app.attachment': 'attachment',
  'app.attachment_2': '(attachment)',
  'app.back_to_an_ordinary_member': 'Back to an ordinary member',
  'app.back_to_stream': 'Back to stream',
  'app.back_to_the_grid': 'Back to the grid',
  'app.cancel': 'Cancel',
  'app.cancelling': 'Cancelling…',
  'app.change': 'Change…',
  'app.change_hotkey': 'Change hotkey ({current})',
  'app.change_source': 'Change source',
  'app.change_source_or_stop_sharing': 'Change source or stop sharing',
  'app.change_the_name_or_put': 'Change the name, or put a password on it',
  'app.change_what_the_heading_says': 'Change what the heading says',
  'app.checking': 'Checking {address}…',
  'app.checking_2': 'Checking…',
  'app.choose': 'Choose…',
  'app.choose_a_password': 'Choose a password',
  'app.clear': 'Clear',
  'app.click_then_press_a_combination': 'Click, then press a combination',
  'app.click_to_change': 'Click to change',
  'app.click_to_expand': 'Click to expand',
  'app.click_to_see_the_attachment': 'Click to see the attachment',
  'app.click_to_switch_or_add': 'Click to switch or add a server',
  'app.click_to_switch_or_add_2': '{address} -- click to switch or add a server',
  'app.clip_saved_s_mb': 'Clip saved — {seconds}s, {size} MB',
  'app.clips_off': 'Clips off.',
  'app.clips_on_the_last_s': 'Clips on — the last {CLIP_SECONDS}s of each stream will be kept in memory.',
  'app.close': 'Close {username}',
  'app.closed_click_to_watch_again': 'Closed · click to watch again',
  'app.colour': 'Colour {colour}',
  'app.connect': 'Connect',
  'app.connecting': 'Connecting…',
  'app.connecting_to': 'Connecting to {username}…',
  'app.connection_quality_measuring': 'Connection quality: measuring',
  'app.connection_quality_milliseconds': 'Connection quality: {ms} milliseconds',
  'app.continue': 'Continue',
  'app.could_not_add': 'Could not add {name}: {message}',
  'app.could_not_apply_the_camera': 'Could not apply the camera background ({message}). Using the plain camera.',
  'app.could_not_be_registered': 'Could not be registered.',
  'app.could_not_join': 'Could not join: {error}',
  'app.could_not_list_audio_devices': 'Could not list audio devices: {message}',
  'app.could_not_open_that_audio': 'Could not open that audio input: {message}',
  'app.could_not_play': 'Could not play "{name}": {message}',
  'app.could_not_read_that_image': 'Could not read that image.',
  'app.could_not_save_the_clip': 'Could not save the clip: {message}',
  'app.could_not_share_your_screen': 'Could not share your screen: {message}',
  'app.could_not_switch_camera': 'Could not switch camera.',
  'app.could_not_update': 'Could not update: {message}',
  'app.create': 'Create',
  'app.create_account': 'Create account',
  'app.create_one': 'Create one',
  'app.deafen': 'Deafen',
  'app.deafened': 'Deafened',
  'app.delete': 'Delete #{name}?',
  'app.delete_2': 'Delete',
  'app.delete_s_account': 'Delete {who}\'s account?',
  'app.delete_the_account': 'Delete the account',
  'app.delete_the_clip': 'Delete the clip "{name}"?',
  'app.delete_the_group': 'Delete the group "{name}"?',
  'app.delete_the_group_2': 'Delete the group',
  'app.delete_this_channel': 'Delete this channel',
  'app.delete_this_group': 'Delete this group',
  'app.delete_this_message': 'Delete this message?',
  'app.disconnected_you': '{by} disconnected you.',
  'app.display_name': 'Display name',
  'app.download': 'Download',
  'app.download_2': 'Download ({attachmentBytes})',
  'app.downloading': 'Downloading {name}… {received}',
  'app.downloading_in_the_background': 'Downloading {name} in the background.',
  'app.drag_to_another_voice_channel': 'Drag to another voice channel to move, or right-click for controls',
  'app.edit': 'Edit #{name}',
  'app.edit_2': 'Edit',
  'app.edit_message': 'Edit message',
  'app.edit_the_layout': 'Edit the layout',
  'app.emoji': 'Emoji',
  'app.end_the_share_for_everybody': 'End the share for everybody watching',
  'app.end_the_stream_for_everybody': 'End the stream for everybody watching',
  'app.everything_written_in_it_goes': 'Everything written in it goes too. This cannot be undone.',
  'app.exit_fullscreen_esc': 'Exit fullscreen (Esc)',
  'app.folders_cannot_be_sent_zip': 'Folders cannot be sent. Zip it first, or drop the files inside it.',
  'app.force_mute': 'Force mute',
  'app.forget_this_server_and_the': 'Forget this server and the sign-in saved for it',
  'app.fullscreen': 'Fullscreen',
  'app.game_night': 'Game Night',
  'app.go_to_the_message_this': 'Go to the message this answers',
  'app.going_live': 'Going live…',
  'app.gradient': '{name} gradient',
  'app.group_a_folder': 'Group (a folder)',
  'app.harmony': 'Harmony {current}',
  'app.harmony_is_available': 'Harmony {version} is available.',
  'app.harmony_is_ready_to_install': 'Harmony {version} is ready to install.',
  'app.harmony_voices_soundpad_and_sounds': 'Harmony — voices, soundpad and sounds (recommended)',
  'app.hear_my_own_audio': 'Hear my own audio',
  'app.hear_your_own_stream': 'Hear your own stream',
  'app.hide': 'Hide',
  'app.hide_preview': 'Hide preview',
  'app.hide_the_preview': 'Hide the preview',
  'app.how_loudly_you_hear_this': 'How loudly you hear this person',
  'app.in_the_channel': '{n} in the channel',
  'app.in_voice': 'In voice',
  'app.is_files_on_this_server': '{name} is {size}. Files on this server are limited to {limit}.',
  'app.is_full_people': '{name} is full ({cap} people).',
  'app.is_not_answering_click_to': '{address} is not answering -- click to switch or add a server',
  'app.join': 'Join',
  'app.join_a_voice_channel_first': 'Join a voice channel first.',
  'app.jump_to_this_message': 'Jump to this message',
  'app.kind': 'Kind',
  'app.later': 'Later',
  'app.leave_the_password_empty_to': 'Leave the password empty to remove it.',
  'app.live_as': 'Live as {username}',
  'app.live_updates_unavailable': 'Live updates unavailable: {message}',
  'app.locked': 'locked',
  'app.louder_than_the_original_amplified': 'Louder than the original. Amplified audio can distort.',
  'app.make_admin': 'Make admin',
  'app.make_an_admin': 'Make {name} an admin?',
  'app.matching': 'Matching "{value}"',
  'app.maximize': 'Maximize {username}',
  'app.maximize_2': 'Maximize {name}',
  'app.message': 'Message',
  'app.move_down': 'Move down',
  'app.move_this_person': 'Move this person',
  'app.move_up': 'Move up',
  'app.moved_you_to': '{by} moved you to {name}.',
  'app.mute': 'Mute {username}',
  'app.mute_2': 'Mute',
  'app.mute_everything': 'Mute everything',
  'app.mute_for_me': 'Mute for me',
  'app.mute_mic': 'Mute mic',
  'app.mute_the_soundpad': 'Mute the soundpad',
  'app.mute_this_share': 'Mute this share',
  'app.muted': 'Muted',
  'app.muted_2': 'muted',
  'app.name': 'Name',
  'app.name_this_clip': 'Name this clip',
  'app.name_this_emoji': 'Name this emoji',
  'app.needs_a_password': '{name} needs a password',
  'app.new_channel': 'New channel',
  'app.nickname': 'Nickname',
  'app.no_account_yet': 'No account yet?',
  'app.no_audio': 'No audio',
  'app.no_clips_yet_add_one': 'No clips yet. Add one.',
  'app.no_gpu_encoder_available_falling': 'No GPU encoder available ({videoEncode}) — falling back to software H.264, which is slower but works everywhere.',
  'app.no_matches': 'No matches ({mode}).',
  'app.no_password': 'No password',
  'app.no_picture_chosen': 'No picture chosen',
  'app.nobody_has_added_any_clips': 'Nobody has added any clips.',
  'app.not_set': 'Not set',
  'app.not_you': 'Not you?',
  'app.nothing_called': 'Nothing called "{value}".',
  'app.nothing_matching': 'Nothing matching "{value}".',
  'app.nothing_share_all_system_audio': 'Nothing — share all system audio',
  'app.nothing_to_monitor_this_source': 'Nothing to monitor: this source has no audio',
  'app.notifies_the_whole_server': 'notifies the whole server',
  'app.off': 'Off',
  'app.off_encoding_on_the_cpu': 'Off — encoding on the CPU. Turn this back on unless viewers saw a corrupt picture.',
  'app.one_file_per_message_is': 'One file per message: {name} is attached. Send it, then drop the next.',
  'app.one_place_higher_in_the': 'One place higher in the list',
  'app.one_place_lower_in_the': 'One place lower in the list',
  'app.online': 'Online',
  'app.open_to_everyone': 'Open to everyone',
  'app.p_fps': '{height}p · {fps} fps',
  'app.password': 'Password',
  'app.pause': 'Pause',
  'app.pin': 'Pin',
  'app.play_this_clip_from_anywhere': 'Play this clip from anywhere, even inside a game',
  'app.preview_hidden': 'Preview hidden',
  'app.preview_hidden_you_are_still': 'Preview hidden. You are still live — this only stops Harmony drawing it.',
  'app.preview_paused': 'Preview paused',
  'app.react': 'React',
  'app.reactions_that_used_it_keep': 'Reactions that used it keep their count and fall back to the text.',
  'app.recent': 'Recent',
  'app.reconnecting': 'Reconnecting…',
  'app.remove': 'Remove :{name}:',
  'app.remove_2': 'Remove :{name}:?',
  'app.remove_3': 'Remove',
  'app.remove_admin': 'Remove admin',
  'app.remove_hotkey': 'Remove hotkey',
  'app.remove_s_admin': 'Remove {name}\'s admin?',
  'app.removes_the_channel_and_everything': 'Removes the channel and everything written in it',
  'app.rename': 'Rename "{name}"',
  'app.rename_or_set_a_password': 'Rename or set a password',
  'app.rename_this_group': 'Rename this group',
  'app.reopen': 'Reopen {username}',
  'app.replace': 'Replace',
  'app.replace_this_file': 'Replace this file',
  'app.reply': 'Reply',
  'app.restart': 'Restart',
  'app.restart_to_update': 'Restart to update?',
  'app.resume': 'Resume',
  'app.right_click_for_admin_controls': 'Right-click for admin controls',
  'app.right_click_for_volume_and': 'Right-click for volume and controls',
  'app.save': 'Save',
  'app.save_the_last_seconds': 'Save the last {CLIP_SECONDS} seconds',
  'app.saved': 'Saved.',
  'app.saved_2': 'Saved {name}.',
  'app.saved_it_applies_next_time': 'Saved. It applies next time Harmony starts — restarting now would end your stream.',
  'app.saved_restart_harmony_to_apply': 'Saved. Restart Harmony to apply it — click here to restart now.',
  'app.saved_the_media_relay_keeps': 'Saved. The media relay keeps its old setting until the server is restarted.',
  'app.saving': 'Saving…',
  'app.server_password': 'Server password',
  'app.server_password_not_needed': 'Server password (not needed)',
  'app.set_hotkey': 'Set hotkey',
  'app.share_screen_here': 'Share screen here',
  'app.sharing_in': 'Sharing in {name}',
  'app.sharing_without_audio': 'Sharing without audio.',
  'app.show': 'Show',
  'app.show_a_different_screen_or': 'Show a different screen or window without ending the stream',
  'app.show_a_preview_of_what': 'Show a preview of what you are sharing',
  'app.show_preview': 'Show preview',
  'app.show_this_one_big': 'Show this one big',
  'app.sign_in': 'Sign in',
  'app.sign_in_first': 'Sign in first.',
  'app.sign_in_to_a_server': 'Sign in to a server to see its soundpad clips.',
  'app.sign_out': 'Sign out',
  'app.signed_in_as': 'Signed in as {name}.',
  'app.soundpad_clips': 'Soundpad clips',
  'app.start_again_from_midnight': 'Start again from Midnight',
  'app.start_camera': 'Start camera',
  'app.start_streaming': 'Start streaming',
  'app.starting_camera': 'Starting camera…',
  'app.stop_camera': 'Stop camera',
  'app.stop_hearing_my_own_audio': 'Stop hearing my own audio',
  'app.stop_hearing_your_own_stream': 'Stop hearing your own stream',
  'app.stop_sharing': 'Stop sharing',
  'app.stop_streaming': 'Stop streaming',
  'app.stop_this_combination_doing_it': 'Stop this combination doing it',
  'app.stop_this_combination_playing_the': 'Stop this combination playing the clip',
  'app.stop_watching_this_and_stop': 'Stop watching this, and stop downloading it',
  'app.stream_ended': 'Stream ended',
  'app.stream_ended_waiting_for': 'Stream ended. Waiting for {username}…',
  'app.switching': 'Switching…',
  'app.testing': 'Testing…',
  'app.text_channel': 'Text channel',
  'app.that_camera_cannot_do_that': 'That camera cannot do that quality. Back to the previous setting.',
  'app.that_camera_could_not_be': 'That camera could not be opened. Still using the previous one.',
  'app.that_file_could_not_be': 'That file could not be read as a picture.',
  'app.that_image_is_too_detailed': 'That image is too detailed to use as a logo.',
  'app.that_is_not_the_right': 'That is not the right nickname. Nothing was deleted.',
  'app.that_message_is_no_longer': 'That message is no longer in this channel.',
  'app.that_microphone_could_not_be': 'That microphone could not be opened. Still using the previous one.',
  'app.that_one_cannot_be_empty': 'That one cannot be empty.',
  'app.that_one_was_not_right': 'That one was not right.',
  'app.that_picture_is_too_detailed': 'That picture is too detailed to shrink.',
  'app.that_picture_is_too_detailed_2': 'That picture is too detailed to shrink into an emoji.',
  'app.that_source_was_not_allowed': 'That source was not allowed.',
  'app.the_address_you_were_given': 'The address you were given for your Harmony server.',
  'app.the_camera_could_not_be': 'The camera could not be reopened. Turn it off and on again.',
  'app.the_camera_could_not_be_2': 'The camera could not be opened again to change the background.',
  'app.the_camera_stopped_turn_it': 'The camera stopped. Turn it off and on again.',
  'app.the_channels_in_it_stay': 'The channels in it stay',
  'app.the_channels_in_it_stay_2': 'The channels in it stay, and move back to the top of the list.',
  'app.the_original_message_was_deleted': 'The original message was deleted.',
  'app.the_server_never_saw_this': 'The server never saw this stream go live. Someone else may already be publishing under this name.',
  'app.the_two_passwords_do_not': 'The two passwords do not match.',
  'app.they_can_manage_channels_mute': 'They can manage channels, mute and move people',
  'app.they_go_back_to_being': 'They go back to being an ordinary member.',
  'app.this_build_cannot_choose_an': 'This build cannot choose an output device; using the system default.',
  'app.this_channel_did_not_give': 'This channel did not give out a screen path. Rejoin it.',
  'app.this_is_the_last_step': 'This is the last step.',
  'app.this_server': 'This server',
  'app.this_server_asks_for_a': 'This server asks for a password before anything else.',
  'app.this_server_has_a_password': 'This server has a password. Leave this blank to keep the one it has.',
  'app.this_server_has_accounts_enter': 'This server has accounts. Enter your password, or create an account.',
  'app.this_server_has_no_password': 'This server has no password. Type one here to start asking for it.',
  'app.this_server_has_no_soundpad': 'This server has no soundpad clips yet. They are listed here as they are added.',
  'app.this_session_expired_sign_in': 'This session expired. Sign in again.',
  'app.turn_your_camera_on_in': 'Turn your camera on in a voice channel to see it here.',
  'app.type_to_confirm': 'Type {nickname} to confirm',
  'app.undeafen': 'Undeafen',
  'app.unlocked': 'unlocked',
  'app.unmute': 'Unmute',
  'app.unmute_everything': 'Unmute everything',
  'app.unmute_for_me': 'Unmute for me',
  'app.unmute_mic': 'Unmute mic',
  'app.unmute_the_soundpad': 'Unmute the soundpad',
  'app.unpin': 'Unpin',
  'app.upload_cancelled': 'Upload cancelled.',
  'app.use_this_source': 'Use this source',
  'app.viewers_will_hear': 'Viewers will hear {label}.',
  'app.viewers_will_hear_all_system': 'Viewers will hear all system audio.',
  'app.viewers_will_hear_only_this': 'Viewers will hear only this application.',
  'app.viewers_will_hear_system_audio': 'Viewers will hear system audio, except {name}.',
  'app.voice_channel': 'Voice channel',
  'app.voice_connected': 'Voice connected',
  'app.volume_for': 'Volume for {username}',
  'app.volume_for_this_share': 'Volume for this share',
  'app.wait_for_the_file_already': 'Wait for the file already uploading to finish.',
  'app.waiting_for_keys': 'Waiting for keys…',
  'app.waiting_for_to_start_sharing': 'Waiting for {username} to start sharing…',
  'app.watch_this_again': 'Watch this again',
  'app.watching': '{viewers} watching',
  'app.watching_2': 'Watching {username}',
  'app.will_encode_on_the_cpu': 'Will encode on the CPU after a restart.',
  'app.will_use_the_gpu_again': 'Will use the GPU again after a restart.',
  'app.you_already_hear_this_audio': 'You already hear this audio through your speakers',
  'app.you_are_live_restarting_now': 'You are live. Restarting now ends your stream; the update also installs whenever you quit.',
  'app.your_camera_path_is_already': 'Your camera path is already in use.',
  'app.your_chosen_camera_is_unplugged': 'Your chosen camera is unplugged. Using the default one.',
  'app.your_display_name': 'Your display name',
  'app.your_screen_share_lost_its': 'Your screen share lost its connection.',

  // --- ask_cancel
  'ask_cancel.cancel': 'Cancel',

  // --- audio
  'audio.input_n': 'Audio input {n}',
  'audio.selected_input': 'the selected input',
  'audio.unavailable_all': 'Per-app audio unavailable — ALL system audio will be shared. {reason}',
  'audio.unavailable_none': 'Per-app audio unavailable — sharing without sound. {reason}',

  // --- audio_input_field
  'audio_input_field.audio_input': 'Audio input',

  // --- background
  'background.file_too_big': 'That file is {size} MB. The limit is {limit} MB.',
  'background.the_camera_has_no_video': 'The camera has no video to work on.',
  'background.webgl2_is_not_available': 'WebGL2 is not available.',

  // --- bg_group
  'bg_group.a_picture_or_a': 'A picture or a GIF, up to 25 MB. It stays on this computer.',
  'bg_group.background_colour': 'Background colour',
  'bg_group.blur': 'Blur',
  'bg_group.camera_background': 'Camera background',
  'bg_group.colours': 'Colours',
  'bg_group.custom': 'Custom',
  'bg_group.direction': 'Direction',
  'bg_group.done_on_your_computer': 'Done on your computer before anything is sent. Nobody, the server included, ever sees what is behind you.',
  'bg_group.first_colour': 'First colour',
  'bg_group.from': 'From',
  'bg_group.gradient_from': 'Gradient from',
  'bg_group.gradient_to': 'Gradient to',
  'bg_group.gradients': 'Gradients',
  'bg_group.pick_any_colour': 'Pick any colour',
  'bg_group.second_colour': 'Second colour',
  'bg_group.to': 'To',

  // --- bg_mode
  'bg_mode.blur': 'Blur',
  'bg_mode.colour': 'Colour',
  'bg_mode.gradient': 'Gradient',
  'bg_mode.image': 'Image',
  'bg_mode.none': 'None',

  // --- bg_remove
  'bg_remove.remove': 'Remove',

  // --- broadcast_clip
  'broadcast_clip.clip': '✂ Clip',

  // --- broadcast_watch
  'broadcast_watch.watch_others': 'Watch others',

  // --- change_source
  'change_source.change_source': 'Change source',

  // --- channel_dock
  'channel_dock.change_your_display_name': 'Change your display name',
  'channel_dock.change_your_picture': 'Change your picture',
  'channel_dock.devices_and_appearance': 'Devices and appearance',

  // --- channels
  'channels.mentions': { one: '{count} message mentions you', other: '{count} messages mention you' },

  // --- chat
  'chat.drop_title': 'Drop to send in #{name}',
  'chat.results': { one: '{count} result ({mode})', other: '{count} results ({mode})' },
  'chat.this_channel': 'this channel',

  // --- chat_active
  'chat_active.search_messages_people_or': 'Search messages, people or media',

  // --- chat_attach
  'chat_attach.attach': 'Attach',

  // --- chat_drop
  'chat_drop.one_file_per_message': 'One file per message. It is attached, ready to send.',

  // --- chat_emoji
  'chat_emoji.emoji': 'Emoji',

  // --- chat_form
  'chat_form.attach_a_file': 'Attach a file',
  'chat_form.emoji': 'Emoji',
  'chat_form.message': 'Message',
  'chat_form.send': 'Send',

  // --- chat_pending
  'chat_pending.don_t_send_this': 'Don\'t send this',

  // --- chat_pending_clear
  'chat_pending_clear.remove': 'Remove',

  // --- chat_reply
  'chat_reply.cancel_the_reply': 'Cancel the reply',
  'chat_reply.replying_to': 'Replying to',

  // --- chat_reply_clear
  'chat_reply_clear.cancel_reply': 'Cancel reply',

  // --- chat_search_clear
  'chat_search_clear.clear': 'Clear',

  // --- chat_send
  'chat_send.send': 'Send',

  // --- chat_upload
  'chat_upload.cancel_the_upload': 'Cancel the upload',
  'chat_upload.upload_progress': 'Upload progress',

  // --- chat_upload_cancel
  'chat_upload_cancel.cancel_upload': 'Cancel upload',

  // --- clip
  'clip.could_not_read_the_video': 'Could not read the video parameters from this stream.',
  'clip.no_keyframe_buffered_yet_give': 'No keyframe buffered yet; give it a few seconds.',

  // --- comp
  'comp.add_a_screen_window_or': 'Add a screen, window or camera…',
  'comp.add_a_source': 'Add a source',
  'comp.add_source': '+ Add source',
  'comp.bring_to_front': 'Bring to front',
  'comp.could_not_add': 'Could not add {name}: {message}',
  'comp.crop': 'Crop',
  'comp.cropping': 'Cropping {name}',
  'comp.done': 'Done',
  'comp.empty_hint': 'Right-click to add a screen, window or camera.',
  'comp.fill_canvas': 'Fill canvas',
  'comp.finish_cropping': 'Finish cropping',
  'comp.finish_free_resize': 'Finish free resize',
  'comp.fit_to_canvas': 'Fit to canvas',
  'comp.free_resize': 'Free resize: {name}',
  'comp.free_resize_stretch': 'Free resize (stretch)',
  'comp.hint': 'Live as you edit. Drag to move, drag a corner to resize, right-click for more.',
  'comp.looking': 'Looking for sources…',
  'comp.nothing_to_add': 'Nothing to add.',
  'comp.original_size_1_1': 'Original size (1:1)',
  'comp.remove': 'Remove {name}',
  'comp.reset_crop': 'Reset crop',
  'comp.send_to_back': 'Send to back',
  'comp.size_25_of_the_width': 'Size: 25% of the width',
  'comp.size_50_of_the_width': 'Size: 50% of the width',
  'comp.size_75_of_the_width': 'Size: 75% of the width',
  'comp.title': 'Composition',

  // --- connect
  'connect.enter_address': 'Enter the address of your Harmony server.',
  'connect.not_answering': '{host} is not answering. Check that it is running, or pick another server.',
  'connect.owner_key_refused': 'That owner key was not accepted, so this account is an ordinary member.',
  'connect.pick_username': 'Pick a username.',
  'connect.username_hint_login': 'The nickname you registered with.',
  'connect.username_hint_new': 'This becomes your permanent name. 2-20 characters, and it is what your stream is called.',
  'connect.username_hint_stream': 'Free name → you start streaming. Name already live → you join and watch.',
  'connect.wrong_password': 'Wrong server password.',

  // --- devices
  'devices.camera': 'camera',
  'devices.microphone': 'microphone',
  'devices.output': 'output',
  'devices.unplugged': { one: 'Your chosen {what} is unplugged. Using the system default until it is back.', other: 'Your chosen {what} are unplugged. Using the system default until it is back.' },

  // --- devices_close
  'devices_close.done': 'Done',

  // --- diag
  'diag.connected': 'connected',
  'diag.connection_test': 'Connection test',
  'diag.got_role': 'got {role}',
  'diag.no_path': 'no working network path was found',
  'diag.none': 'none',
  'diag.signaling_on': 'signaling on {address}',
  'diag.step_exchange': 'Exchange connection details',
  'diag.step_media': 'Media server is running',
  'diag.step_reach': 'Reach the Harmony server',
  'diag.step_reserve': 'Reserve a test name',
  'diag.step_send': 'Send video to the server',
  'diag.step_stun': 'Discover your public address (STUN)',
  'diag.step_test': 'Connection test',
  'diag.stun_not_needed': 'not needed: this server offers no STUN',
  'diag.stun_only': 'only {types} — UDP may be blocked',
  'diag.verdict_blocked_ports': 'Signalling works but media cannot get through. Your network is blocking the media ports. A TURN relay would be needed.',
  'diag.verdict_media_down': 'The server is up but its media server is not. This is a server-side problem.',
  'diag.verdict_ok': 'Everything works. Streaming and watching should both be fine from this network.',
  'diag.verdict_reserve': 'Could not reserve a scratch name; try again in a moment.',
  'diag.verdict_stopped': 'The test stopped early: {message}',
  'diag.verdict_tcp': 'Working, over the TCP fallback. Expect higher delay than usual, but it will stream.',
  'diag.verdict_udp_blocked': 'UDP appears to be blocked on your network. The server also offers a TCP path; if this still fails, a TURN relay would be needed.',
  'diag.verdict_unreachable': 'The server could not be reached at all. Check the address, and that your network allows this port.',

  // --- diag_close
  'diag_close.close': 'Close',

  // --- download
  'download.progress': 'Downloading {name}… {percent}% ({received} of {total})',

  // --- edit_composition
  'edit_composition.edit_layout': 'Edit layout',

  // --- emoji
  'emoji.name_hint': 'The name is the trigger: typing it between colons puts the picture in a message. Letters, numbers and underscores.',

  // --- emoji_add
  'emoji_add.add': '+ Add',

  // --- emoji_pop
  'emoji_pop.search_emoji': 'Search emoji',
  'emoji_pop.upload_a_custom_emoji': 'Upload a custom emoji',

  // --- exclude_field
  'exclude_field.exclude_audio': 'Exclude audio',

  // --- fallback_field
  'fallback_field.if_per_app_audio': 'If per-app audio is unavailable',

  // --- gpu
  'gpu.current': 'Currently on {active}, of {all}. Leave this alone unless you are troubleshooting: the discrete GPU is normally the right choice, because it is where the game being captured already lives.',
  'gpu.hint': 'This machine has two GPUs ({all}). If your screen is wired to the integrated one, every frame Harmony draws is copied between GPUs before it reaches the display, which costs roughly 10% of the machine while you stream. Look for a MUX switch, NVIDIA Advanced Optimus, or a "display mode" setting in your laptop vendor\'s utility, and point the panel at the discrete GPU. Worth doing once — it is the single largest thing you can change.',
  'gpu.on_both': 'On — your GPU is encoding and decoding. NVENC, AMF or Quick Sync, whichever your driver provides.',
  'gpu.on_encode': 'On — your GPU is encoding. NVENC, AMF or Quick Sync, whichever your driver provides.',
  'gpu.unknown': 'an unknown GPU',

  // --- gpu_preference
  'gpu_preference.the_dedicated_gpu_normally': 'The dedicated GPU — normally the right one',
  'gpu_preference.the_integrated_gpu': 'The integrated GPU',
  'gpu_preference.whichever_gpu_windows_picks': 'Whichever GPU Windows picks',

  // --- gpu_preference_field
  'gpu_preference_field.run_harmony_on': 'Run Harmony on',

  // --- hotkey_recorder
  'hotkey_recorder.press_the_combination_you': 'Press the combination you want. Esc cancels.',

  // --- hotkey_recorder_cancel
  'hotkey_recorder_cancel.cancel': 'Cancel',

  // --- hotkey_recorder_clear
  'hotkey_recorder_clear.remove_hotkey': 'Remove hotkey',

  // --- hotkeys
  'hotkeys.bad_key': 'That key cannot be used as a hotkey.',
  'hotkeys.camera': 'Turn camera on / off',
  'hotkeys.deafen': 'Deafen / undeafen',
  'hotkeys.err_duplicate': 'Bound to something else as well.',
  'hotkeys.err_in_use': 'Another program already uses this combination. Pick another.',
  'hotkeys.err_invalid': 'Not a combination Windows can register.',
  'hotkeys.join_first': 'Join a voice channel first: this hotkey works from inside a call.',
  'hotkeys.mac_option': 'macOS does not pass Option shortcuts to an app in the background. Add Command or Control.',
  'hotkeys.mute': 'Mute / unmute microphone',
  'hotkeys.needs_modifier': 'Add Ctrl or Alt. On its own this key would stop working in every other program while Harmony is open.',
  'hotkeys.not_registered': 'could not be registered.',

  // --- leave_stream
  'leave_stream.leave': 'Leave',

  // --- lightbox
  'lightbox.close': 'Close',
  'lightbox.save_a_copy': 'Save a copy',

  // --- lightbox_close
  'lightbox_close.close': 'Close',

  // --- lightbox_save
  'lightbox_save.save': 'Save',

  // --- limit
  'limit.bandwidth': 'limited by your upload speed',
  'limit.cpu': 'limited by this computer',
  'limit.other': 'limited',

  // --- live_list
  'live_list.live_now': 'Live now',

  // --- main
  'main.deafen': 'Deafen',
  'main.deafened': 'deafened',
  'main.disconnect': 'Disconnect',
  'main.mute': 'Mute',
  'main.muted': 'muted',
  'main.open': 'Open Harmony',
  'main.quit': 'Quit Harmony',
  'main.save_attachment': 'Save attachment',
  'main.still_running': 'Harmony is still running',
  'main.still_running_balloon': 'It keeps going down here, calls included. Right-click this icon to quit.',
  'main.still_running_notice': 'It keeps going in the tray, calls included. Right-click the icon to quit.',
  'main.undeafen': 'Undeafen',
  'main.unmute': 'Unmute',

  // --- member_list
  'member_list.members': 'Members',
  'member_list.resize_the_member_list': 'Resize the member list',

  // --- members
  'members.delete_hint': 'Removes them and everything they have written',
  'members.move': 'Move…',
  'members.offline': 'Offline — {count}',
  'members.online': 'Online — {count}',

  // --- mosaic
  'mosaic.nobody': 'Nobody is streaming right now.',
  'mosaic.none_live': 'None of the chosen streams are live.',
  'mosaic.none_open': 'No streams open. Use + Add stream to bring one back.',

  // --- mosaic_add
  'mosaic_add.add_stream': '+ Add stream',

  // --- mosaic_hint
  'mosaic_hint.each_tile_has_its': 'Each tile has its own volume. ⤢ maximizes, ⛶ or double-click goes fullscreen, ✕ closes.',

  // --- nav
  'nav.back_to_channels': 'Back to channels',
  'nav.back_to_stream': 'Back to my stream',
  'nav.leave': 'Leave',

  // --- owner_key_field
  'owner_key_field.owner_key': 'Owner key',
  'owner_key_field.printed_in_the_server': 'Printed in the server log on first start',

  // --- password_field
  'password_field.server_password': 'Server password',
  'password_field.this_server_asks_for': 'This server asks for one',

  // --- picker
  'picker.cameras_capture_cards': 'Cameras & capture cards',
  'picker.choose_what_to_share': 'Choose what to share',
  'picker.compose_hint': 'Pick any number to start with, or none. Once you are live you can add, move, resize and crop them: right-click the preview.',
  'picker.composite': 'Composite',
  'picker.framerate': 'Framerate',
  'picker.loading': 'Loading…',
  'picker.look_for_sources_again': 'Look for sources again',
  'picker.none_cameras': 'No cameras or capture cards found.',
  'picker.none_screen': 'No screens found.',
  'picker.none_window': 'No windows found.',
  'picker.resolution': 'Resolution',
  'picker.screens': 'Screens',
  'picker.source_type': 'Source type',
  'picker.sources': 'Sources',
  'picker.streaming_as': 'Streaming as',
  'picker.windows': 'Windows',

  // --- picker_refresh
  'picker_refresh.refresh': 'Refresh',

  // --- preview
  'preview.hidden_text': 'You are still live. Drawing the preview costs GPU work on top of the game you are sharing, so hiding it is free performance.',
  'preview.paused_text': 'You are still live. Harmony is not drawing the preview while the window is minimised, because nothing would see it — that work would be pure waste.',

  // --- priority
  'priority.sharp': 'Sharp — keep resolution',
  'priority.smooth': 'Smooth — keep framerate',

  // --- privacy
  'privacy.hide': 'Hide your details',
  'privacy.show': 'Show your details',

  // --- profile
  'profile.back_to_username': 'Back to your username.',
  'profile.banner_changed': 'Banner changed.',
  'profile.banner_removed': 'Banner removed.',
  'profile.banner_too_big': 'That banner is over 2 MB. Pick a smaller GIF, or a still picture, which is shrunk for you.',
  'profile.font_default': 'Default',
  'profile.font_saved': 'Font changed.',
  'profile.join_sound_changed': 'Join sound set ({seconds} seconds).',
  'profile.join_sound_custom': 'Your own sound',
  'profile.join_sound_default': 'The usual tone',
  'profile.join_sound_removed': 'Back to the usual tone.',
  'profile.join_sound_too_big': 'That file is too large. Pick one under 20 MB.',
  'profile.join_sound_trimmed': 'Join sound set. It was longer than {seconds} seconds, so it was cut there.',
  'profile.join_sound_unreadable': 'Could not read that as audio.',
  'profile.name_dialog_text': 'Shown to everybody on this server. Leave it empty to go back to "{nickname}". Capitals, spaces and accents are all fine.',
  'profile.picture_changed': 'Picture changed.',
  'profile.picture_removed': 'Picture removed.',
  'profile.saved': 'Saved.',

  // --- profile_choose
  'profile_banner.choose_banner': 'Choose banner',
  'profile_banner.remove_banner': 'Remove banner',
  'profile_choose.change_picture': 'Change picture',

  // --- profile_name_reset
  'profile_name_reset.use_my_username': 'Use my username',

  // --- profile_name_save
  'profile_name_save.save': 'Save',

  // --- profile_remove
  'profile_remove.remove_picture': 'Remove picture',

  // --- quality
  'profile_sound.choose_sound': 'Choose sound',
  'profile_sound.play': 'Play',
  'profile_sound.remove_sound': 'Remove',
  'ptt.record_title': 'Push-to-talk key',
  'ptt.reset_done': 'Reset. Harmony is restarting; allow it when macOS asks.',
  'ptt.reset_failed': 'Could not reset it from here. In System Settings, select Harmony in the Accessibility list and press the minus button, then restart Harmony.',
  'ptt.scope_global': 'Works in any application while you are in a voice channel.',
  'ptt.scope_no_key': 'Choose a key. Any key or combination works, and it is not taken away from other programs.',
  'ptt.scope_permission': 'macOS has not allowed Harmony to see keys in other applications, so for now it only works while Harmony is in front. Turn Harmony on in System Settings → Privacy & Security → Accessibility, then switch push to talk off and on again.',
  'ptt.scope_unavailable': 'This computer will not let Harmony watch keys in other applications, so it only works while Harmony is the window in front.',
  'ptt.scope_window': 'Works while Harmony is the window in front.',
  'ptt.status_talking': 'Talking',
  'ptt.status_waiting': 'Push to talk',
  'quality.fps': '{fps} fps',
  'quality.native': 'Native',
  'quality.note_heavy': 'Higher quality uses more bandwidth and more of this computer, and the camera background has more to do with a bigger picture.',
  'quality.note_live': 'Applies to a running camera straight away.',
  'quality.note_native': 'Native asks the camera for the most it offers, which the sent picture follows.',

  // --- roles
  'roles.admin': 'admin',
  'roles.member': 'member',
  'roles.owner': 'owner',

  // --- scale_reset
  'scale_reset.reset': 'Reset',

  // --- server
  'screen_permission.body': 'macOS has not allowed Screen Recording for Harmony. Switch it on in System Settings, then restart Harmony. If it is already on and this keeps coming back, the switch belongs to an older copy of the app: use "Reset and restart", then allow it when macOS asks.',
  'screen_permission.open_settings': 'Open System Settings',
  'screen_permission.reset': 'Reset and restart',
  'screen_permission.reset_failed': 'Could not reset it from here. In System Settings, select Harmony in the list, press the minus button, then restart Harmony and share again.',
  'screen_permission.restart': 'Restart Harmony',
  'screen_permission.title': 'Harmony cannot see your screen yet',
  'server.storage_note': '{used} used · {free} free on the server\'s disk. Old files nobody uses any more are cleared to make room.',
  'server.storage_note_short': '{used} used. Old files nobody uses any more are cleared to make room.',

  // --- server_add
  'server_add.add_a_server': '+ Add a server',

  // --- server_back
  'server_back.back_to_my_servers': 'Back to my servers',

  // --- server_cancel
  'server_cancel.cancel': 'Cancel',

  // --- server_form
  'server_form.anybody_who_can_reach': 'Anybody who can reach this server can use it.',
  'server_form.leave_blank_to_keep': 'Leave blank to keep it as it is',
  'server_form.logo': 'Logo',
  'server_form.name': 'Name',
  'server_form.no_password_at_all': 'No password at all',
  'server_form.password': 'Password',
  'server_form.shown_in_everybody_s': 'Shown in everybody\'s server list. Square works best; it is shrunk to 256 px.',
  'server_form.this_server': 'This server',
  'server_form.what_it_is_called': 'What it is called in the title bar, for everybody.',

  // --- server_logo_pick
  'server_logo_pick.choose_image': 'Choose image…',

  // --- server_logo_remove
  'server_logo_remove.remove': 'Remove',

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
  'server_menu.search_servers': 'Search servers',

  // --- server_options_empty
  'server_options_empty.no_servers_match': 'No servers match.',

  // --- server_save
  'server_save.save': 'Save',

  // --- server_uploads
  'server_uploads.largest_file': 'Largest file',
  'server_uploads.space_for_files_gb': 'Space for files (GB)',
  'server_uploads.the_biggest_file_anybody': 'The biggest file anybody can send in a chat.',

  // --- session
  'session.account_removed': 'Your account was removed from this server.',
  'session.disconnected': 'Disconnected: {reason}',

  // --- settings
  'settings.appearance': 'Appearance',
  'settings.appearance.appearance': 'Appearance',
  'settings.appearance.bigger': 'Bigger',
  'settings.appearance.colour_palette': 'Colour palette',
  'settings.appearance.everything_at_once_the': 'Everything at once: the type, the icons, the pictures and the spacing between them. This is the window\'s own zoom, so a bigger setting fits less on screen.',
  'settings.appearance.interface_size': 'Interface size',
  'settings.appearance.smaller': 'Smaller',
  'settings.appearance.yours_alone_nothing_is': 'Yours alone. Nothing is sent to the server, and two people in the same channel can be looking at different colours.',
  'settings.hotkeys': 'Hotkeys',
  'settings.hotkeys.hotkeys': 'Hotkeys',
  'settings.hotkeys.work_anywhere_even_while': 'Work anywhere, even while a game has focus. A combination you bind here is taken from every other program while Harmony is open, so use a modifier (Ctrl, Alt, Shift) or an F-key. Every soundpad clip on this server is listed below; right-clicking a clip in the soundpad does the same.',
  'settings.language.auto': 'Automatic ({language})',
  'settings.language.note': 'The language of the menus and messages in this app. People on the same server can each use their own; what is written in a chat stays as it was written.',
  'settings.language.title': 'Language',
  'settings.profile': 'Profile',
  'settings.profile.account': 'Account',
  'settings.profile.banner': 'Banner',
  'settings.profile.banner_note': 'Drawn behind your name in the member list and in voice channels, dimmed and fading out toward the left. A picture or a GIF, up to 2 MB; a still picture is shrunk to fit.',
  'settings.profile.display_name': 'Display name',
  'settings.profile.join_sound': 'Join sound',
  'settings.profile.join_sound_note': 'Played for the people in a voice channel when you join it, instead of the usual tone. Up to 10 seconds: anything longer is cut at 10. Any audio file your computer can play works.',
  'settings.profile.name_font': 'Name font',
  'settings.profile.name_font_note': 'How your display name is drawn for everybody on this server. The fonts come with the app, so everybody sees the same one.',
  'settings.profile.picture': 'Picture',
  'settings.profile.profile': 'Profile',
  'settings.profile.role': 'Role',
  'settings.profile.shown_to_everybody_instead': 'Shown to everybody instead of your username. Capitals, spaces and accents are all fine, and two people can pick the same one. Empty goes back to your username.',
  'settings.profile.shown_to_everybody_on': 'Shown to everybody on this server, cropped to a circle. Any image works; it is shrunk to a small square before it is uploaded. Without one, your initials are drawn instead.',
  'settings.profile.username': 'Username',
  'settings.profile.your_username_is_what': 'Your username is what you sign in with and what people @mention. It does not change.',
  'settings.settings': 'Settings',
  'settings.sounds': 'Sounds',
  'settings.sounds.members_join_sounds': 'Members\' join sounds',
  'settings.sounds.members_join_sounds_hint': 'When somebody who has picked their own join sound joins your voice channel, you hear theirs instead of the usual tone. Off plays the usual tone for everybody.',
  'settings.sounds.mention_sound': 'Mention sound',
  'settings.sounds.sound_effects_volume': 'Sound effects volume',
  'settings.sounds.sounds': 'Sounds',
  'settings.sounds.three_rising_notes_when': 'Three rising notes when somebody writes your name, and the only cue that fires for a channel you are not looking at.',
  'settings.sounds.voice_channel_sounds': 'Voice channel sounds',
  'settings.sounds.when_you_or_somebody': 'When you or somebody else joins or leaves, a stream starts or stops, and when you mute or deafen. Rising means on, falling means off.',
  'settings.updates': 'Updates',
  'settings.updates.updates': 'Updates',
  'settings.voice.camera': 'Camera',
  'settings.voice.camera_quality': 'Camera quality',
  'settings.voice.devices': 'Devices',
  'settings.voice.echo_cancellation': 'Echo cancellation',
  'settings.voice.echo_cancellation_hint': 'Stops your speakers from being picked up by your microphone. Useful without a headset; it can make your voice duck while sound is playing.',
  'settings.voice.frame_rate': 'Frame rate',
  'settings.voice.input_sensitivity': 'Input sensitivity',
  'settings.voice.input_volume': 'Input volume',
  'settings.voice.microphone': 'Microphone',
  'settings.voice.noise_suppression': 'Noise suppression',
  'settings.voice.noise_suppression_hint': 'Filters out steady background noise such as fans and keyboards. It can clip the ends of words.',
  'settings.voice.output': 'Output',
  'settings.voice.pause_hidden_cameras': 'Pause cameras while Harmony is hidden',
  'settings.voice.pause_hidden_cameras_hint': 'When the window is minimised, in the tray or covered, other people\'s cameras are not downloaded or decoded, which saves your connection and the server\'s. They come back the moment you do. Voices and screen shares carry on.',
  'settings.voice.push_to_talk': 'Push to talk',
  'settings.voice.push_to_talk_hint': 'Your microphone stays silent until you hold the key you choose. Muting still wins.',
  'settings.voice.push_to_talk_key': 'Push-to-talk key',
  'settings.voice.resolution': 'Resolution',
  'settings.voice.speak_normally_put_the': 'Speak normally. Put the marker just above where the bar sits when you are quiet, and below where it sits when you talk.',
  'settings.voice.voice_video': 'Voice & video',
  'settings.voice_video': 'Voice & video',

  // --- share
  'share.capture_blocked': 'Screen capture was blocked.',

  // --- soundpad
  'share.capture_blocked_mac': 'macOS blocked the screen capture. Open the source picker and follow the note at the top: if Harmony is already switched on in Screen & System Audio Recording, use "Reset and restart".',
  'soundpad.emoji_hint': 'The emoji is optional, and is what makes a clip findable in a grid of twenty identical buttons.',
  'soundpad.find_the_perfect_sound': 'Find the perfect sound',
  'soundpad.how_loudly_soundpad_clips': 'How loudly soundpad clips play for you',
  'soundpad.too_big': '"{name}" is {size} MB. Clips are limited to {limit} MB -- every client downloads every clip.',

  // --- soundpad_add
  'soundpad_add.add': '+ Add',

  // --- stats
  'stats.encode': 'encode {ms} ms',
  'stats.link': 'link {mbps} Mbps',

  // --- status
  'status.cam': 'camera on',
  'status.deaf': 'deafened -- cannot hear anybody',
  'status.forced': 'muted by an admin',
  'status.muted': 'muted themselves',
  'status.screen': 'sharing a screen',

  // --- step_account
  'step_account.server': 'Server',

  // --- step_server
  'step_server.https_harmony_example_com': 'https://harmony.example.com or 192.168.1.50:8080',
  'step_server.server_address': 'Server address',

  // --- stop_stream
  'stop_stream.stop_streaming': 'Stop streaming',

  // --- test_connection
  'test_connection.test_my_connection': 'Test my connection',

  // --- theme
  'theme.accent': 'Accent',
  'theme.background': 'Background',
  'theme.dark': 'Dark',
  'theme.daylight': 'Daylight',
  'theme.ember': 'Ember',
  'theme.forest': 'Forest',
  'theme.lavender': 'Lavender',
  'theme.midnight': 'Midnight',
  'theme.ocean': 'Ocean',
  'theme.onyx': 'Onyx',
  'theme.panels': 'Panels',
  'theme.text': 'Text',

  // --- toast
  'toast.click_to_show': '(click to show)',

  // --- update_check
  'update_check.check_now': 'Check now',

  // --- updates
  'updates.available': 'Version {version} is available.',
  'updates.checking': 'Checking for updates…',
  'updates.downloading': 'Downloading {version}… {percent}%',
  'updates.downloading_banner': 'Downloading Harmony {version}… {percent}%',
  'updates.error': 'Could not update: {message}',
  'updates.idle': 'Not checked yet.',
  'updates.latest': 'Up to date.',
  'updates.open_page': 'Open download page',
  'updates.ready': 'Version {version} is ready. It installs when you restart or quit.',
  'updates.restart_now': 'Restart now',
  'updates.unsupported_appimage': 'Only the AppImage build updates itself.',
  'updates.unsupported_development': 'Updates apply to an installed build, not a development run.',

  // --- upload
  'upload.progress': '{percent}% · {sent} of {total}',

  // --- view
  'view.broadcast.framerate': 'Framerate',
  'view.broadcast.priority': 'Priority',
  'view.broadcast.resolution': 'Resolution',
  'view.broadcast.stop_drawing_the_preview': 'Stop drawing the preview — the stream keeps running',
  'view.channels.channels': 'Channels',
  'view.channels.create_a_channel': 'Create a channel',
  'view.channels.members': 'Members',
  'view.channels.resize_the_channel_list': 'Resize the channel list',
  'view.channels.server_settings': 'Server settings',
  'view.channels.show_or_hide_the': 'Show or hide the member list',
  'view.channels.sign_out': 'Sign out',
  'view.connect.buffers_already_compressed_video': 'Buffers already-compressed video in memory, so it costs little CPU. Roughly 30 MB per stream at 1080p.',
  'view.connect.encode_on_the_gpu': 'Encode on the GPU',
  'view.connect.harmony': 'Harmony',
  'view.connect.keep_the_last_30': 'Keep the last 30 seconds for clipping',
  'view.connect.options': 'Options',
  'view.connect.self_hosted_voice_video': 'Self-hosted voice, video and chat for your own community',
  'view.mosaic.all_volumes': 'All volumes',
  'view.mosaic.mosaic': 'Mosaic',

  // --- voice
  'voice.measuring': 'Measuring…',
  'voice.ms_to_relay': '{ms} ms to the relay',
  'voice.reconnecting': 'Reconnecting…',

  // --- voice_config
  'voice_config.devices': 'Devices',

  // --- voice_flip
  'voice_flip.switch_camera': 'Switch camera',

  // --- voice_idle
  'voice_idle.pick_a_voice_channel': 'Pick a voice channel to join it.',

  // --- voice_leave
  'voice_leave.disconnect': 'Disconnect',

  // --- voice_panel
  'voice_panel.disconnect': 'Disconnect',
  'voice_panel.soundboard': 'Soundboard',
  'voice_panel.switch_camera': 'Switch camera',

  // --- voice_soundboard
  'voice_soundboard.soundboard': 'Soundboard',

  // --- watch_add
  'watch_add.add_stream': '+ Add stream',

  // --- watch_all
  'watch_all.watch_all': 'Watch all',

  // --- watch_clip
  'watch_clip.clip': '✂ Clip',

  // --- window_audio_fallback
  'window_audio_fallback.share_silently': 'Share silently',
  'window_audio_fallback.use_system_audio': 'Use system audio',
};
