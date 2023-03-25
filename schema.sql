drop schema public cascade;
create schema public;

create table users (
    id int primary key, -- telegram id
    uname text not null, -- telegram username (may change)
    lang text not null, -- 2-char lang code sent in every update. can use this for UI.
    created_at timestamptz not null default now()
);

CREATE TYPE chat_type AS ENUM ('private', 'group', 'supergroup', 'channel');

create table chats (
    id int primary key, -- telegram id
    type chat_type not null,
    voice text null,
    temperature numeric(2, 1) not null default 0.8,
    send_voice boolean not null default true,
    uname text null, -- just useful for debug
    created_at timestamptz not null default now()
);


create table prompts (
    id serial primary key,
    chat_id int not null references chats(id),
    user_id int not null references users(id),
    prompt text not null,
    message_id int not null, -- telegram message_id of the prompt message
    answer text not null,
    prompt_tokens int not null,
    answer_tokens int not null,
    created_at timestamptz not null default now()
    -- idea: delivered? t/f
);

