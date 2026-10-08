---
description: 查看消息、读消息、查看某人的消息或阅读工单消息；浏览用原生选项，明确ID直接阅读，先收附件再读正文
---

Load the `team-mailbox-read` skill through the skill tool, then follow it for this
explicit message-reading request. User filters or intent: $ARGUMENTS

Single unread shortcut: only unread_only=true, a fresh first page (cursor omitted
or cursor=0), messages.length=1 and hasMore=false proves the complete matching set
is one. Unless the user explicitly requests selection, this viewing request is
enough: receive_attachment with only attachment_id successfully before the complete
body, without repeated confirmation. No shortcut in all mode, unknown completeness,
later pages or read-only/local filtering of an earlier multi-message list. For a
specified sender, pass `from` to getmsg and test uniqueness on the complete
server-filtered result; never use limit=1 to force apparent uniqueness (use the
normal limit=10). In all/history mode, even one result needs selection unless
the request directly specifies its ID. After cancel, query again for a new
request; never reuse cached uniqueness. Zero matches
means no reading/download; offer all messages. Attachment failure still asks retry,
explicit skip or cancel. These are Agent instructions, not runtime enforcement.

If the skill is missing, explain that its folder must be installed in the same
OpenCode scope's skills/ directory and stop. Do not improvise a Markdown inbox list.
Reading TEST/BUGFIX/TEST_FIX/RESULT work-order messages belongs to team-mailbox-read;
do not route to dispatch merely because of TEST keywords.
Browsing multiple messages requires native question, not an assistant Markdown
candidate list or table, MCP elicitation or submit prompt. If question is unavailable,
explain the limitation and ask which alternative the user wants; never silently downgrade.
An explicit message ID with direct-read intent needs no redundant selection; follow
the skill's metadata lookup and attachment-before-body workflow for that exact ID.
A sidebar click submits only `读取消息ID n` with the real clicked ID; this is
explicit-ID direct-read intent, so do not ask a duplicate candidate-selection
question. Still locate its attachment.id via getmsg before receiving it and
reading the body. Missing IDs, cancellation and attachment failures follow the
skill's existing safety paths; never substitute another message.
Raw tool JSON may remain visible in host previews/details; do not promise to hide it.
Follow the skill's bounded pagination and user-chosen one-call retry guards;
explicit retry of an unfinished page is allowed, not automatic re-show of a
completed page. Reuse saved attachment state and do not expand text attachments
unless requested.
These are Agent instructions, not runtime enforcement. Do not
install files, set MSG_DOWNLOAD_DIR, send messages or change configuration here.
