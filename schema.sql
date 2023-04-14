drop schema public cascade;
create schema public;

create table users (
    id bigint primary key, -- telegram id
    uname text, -- telegram username (may change)
    lang text, -- 2-char lang code sent in every update. can use this for UI.
    created_at timestamptz not null default now()
);

CREATE TYPE chat_type AS ENUM ('private', 'group', 'supergroup', 'channel');

create table chats (
    id bigint primary key, -- telegram id
    type chat_type not null,
    voice text null,
    temperature numeric(2, 1) not null default 0.8,
    send_voice boolean not null default true,
    uname text null, -- just useful for debug
    model: text not null default 'gpt-3.5-turbo',
    created_at timestamptz not null default now()
);

create table prompts (
    id serial primary key,
    chat_id bigint not null references chats(id),
    user_id bigint not null references users(id),
    prompt text not null,
    message_id bigint not null, -- telegram message_id of the prompt message
    answer text not null,
    prompt_tokens int not null,
    answer_tokens int not null,
    gpt_elapsed int null, -- milliseconds it took OpenAI ChatGPT API to respond
    tts_elapsed int null, -- milliseconds it took for TTS API to respond
    lang text null,
    created_at timestamptz not null default now()
);

create index prompts_chat_id_idx on prompts (chat_id);
create index prompts_user_id_idx on prompts (user_id);

