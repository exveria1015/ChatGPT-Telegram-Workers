import {sendMessageToTelegram, sendPhotoToTelegram, sendChatActionToTelegram, getChatRole} from './telegram.js';
import {DATABASE, ENV, CONST} from './env.js';
import {SHARE_CONTEXT, USER_CONFIG, CURRENT_CHAT_CONTEXT, USER_DEFINE} from './context.js';
import {requestImageFromOpenAI} from './openai.js';
import {mergeConfig} from './utils.js';

const commandAuthCheck = {
  default: function() {
    if (CONST.GROUP_TYPES.includes(SHARE_CONTEXT.chatType)) {
      return ['administrator', 'creator'];
    }
    return false;
  },
  shareModeGroup: function() {
    if (CONST.GROUP_TYPES.includes(SHARE_CONTEXT.chatType)) {
      // 每个人在群里有上下文的时候，不限制
      if (!ENV.GROUP_CHAT_BOT_SHARE_MODE) {
        return false;
      }
      return ['administrator', 'creator'];
    }
    return false;
  },
};

// 命令绑定
const commandHandlers = {
  '/help': {
    help: 'コマンドのヘルプを取得します',
    scopes: ['all_private_chats', 'all_chat_administrators'],
    fn: commandGetHelp,
  },
  '/new': {
    help: '新しい会話を開始します',
    scopes: ['all_private_chats', 'all_group_chats', 'all_chat_administrators'],
    fn: commandCreateNewChatContext,
    needAuth: commandAuthCheck.shareModeGroup,
  },
  '/start': {
    help: 'あなたのIDを取得し、新しい会話を開始します',
    scopes: ['all_private_chats', 'all_chat_administrators'],
    fn: commandCreateNewChatContext,
    needAuth: commandAuthCheck.default,
  },
  '/img': {
    help: '画像を生成します。コマンドの完全な形式は /img image_description です。 例：/img beach_under_moonlight',
    scopes: ['all_private_chats', 'all_chat_administrators'],
    fn: commandGenerateImg,
    needAuth: commandAuthCheck.shareModeGroup,
  },
  '/version': {
    help: '現在のバージョン番号を取得し、更新が必要かどうかを判断します',
    scopes: ['all_private_chats', 'all_chat_administrators'],
    fn: commandFetchUpdate,
    needAuth: commandAuthCheck.default,
  },
  '/setenv': {
    help: 'ユーザー構成を設定します。コマンドの完全な形式は /setenv KEY=VALUE です',
    scopes: [],
    fn: commandUpdateUserConfig,
    needAuth: commandAuthCheck.shareModeGroup,
  },
  '/usage': {
    help: '現在のボットの使用状況を取得します',
    scopes: ['all_private_chats', 'all_chat_administrators'],
    fn: commandUsage,
    needAuth: commandAuthCheck.default,
  },
  '/system': {
    help: '現在のシステム情報を表示します',
    scopes: ['all_private_chats', 'all_chat_administrators'],
    fn: commandSystem,
    needAuth: commandAuthCheck.default,
  },
  '/role': {
    help: 'プリセットの役割を設定します',
    scopes: ['all_private_chats'],
    fn: commandUpdateRole,
    needAuth: commandAuthCheck.shareModeGroup,
  },
};

async function commandUpdateRole(message, command, subcommand) {
  // 显示
  if (subcommand==='show') {
    const size = Object.getOwnPropertyNames(USER_DEFINE.ROLE).length;
    if (size===0) {
      return sendMessageToTelegram('現在役割が定義されていません');
    }
    let showMsg = `現在定義されている役割は以下の通りです(${size}):\n`;
    for (const role in USER_DEFINE.ROLE) {
      if (USER_DEFINE.ROLE.hasOwnProperty(role)) {
        showMsg+=`~${role}:\n<pre>`;
        showMsg+=JSON.stringify(USER_DEFINE.ROLE[role])+'\n';
        showMsg+='</pre>';
      }
    }
    CURRENT_CHAT_CONTEXT.parse_mode = 'HTML';
    return sendMessageToTelegram(showMsg);
  }

  const helpMsg = '形式が正しくありません：コマンドの完全な形式は `/role 操作` です。\n'+
      '以下の`操作`がサポートされています:\n'+
      '`/role show` 現在定義されている役割を表示します。\n'+
      '`/role role_name del` 指定された名前の役割を削除します。\n'+
      '`/role role_name KEY=VALUE` 指定された役割の設定を設定します。\n'+
      '以下の設定項目があります:\n'+
      '  `SYSTEM_INIT_MESSAGE`: 初期化メッセージ\n'+
      '  `OPENAI_API_EXTRA_PARAMS`: OpenAI APIの追加パラメーター、JSON形式である必要があります。';


  const kv = subcommand.indexOf(' ');
  if (kv === -1) {
    return sendMessageToTelegram(helpMsg);
  }
  const role = subcommand.slice(0, kv);
  const settings = subcommand.slice(kv + 1).trim();
  const skv = settings.indexOf('=');
  if (skv === -1) {
    if (settings === 'del') { // 删除
      try {
        if (USER_DEFINE.ROLE[role]) {
          delete USER_DEFINE.ROLE[role];
          await DATABASE.put(
              SHARE_CONTEXT.configStoreKey,
              JSON.stringify(Object.assign(USER_CONFIG, {USER_DEFINE: USER_DEFINE})),
          );
          return sendMessageToTelegram('役割の削除に成功しました');
        }
      } catch (e) {
        return sendMessageToTelegram(`役割の削除中にエラーが発生しました: \`${e.message}\``);
      }
    }
    return sendMessageToTelegram(helpMsg);
  }
  const key = settings.slice(0, skv);
  const value = settings.slice(skv + 1);

  // ROLE结构定义
  if (!USER_DEFINE.ROLE[role]) {
    USER_DEFINE.ROLE[role] = {
      // 系统初始化消息
      SYSTEM_INIT_MESSAGE: ENV.SYSTEM_INIT_MESSAGE,
      // OpenAI API 额外参数
      OPENAI_API_EXTRA_PARAMS: {},
    };
  }
  try {
    mergeConfig(USER_DEFINE.ROLE[role], key, value);
    await DATABASE.put(
        SHARE_CONTEXT.configStoreKey,
        JSON.stringify(Object.assign(USER_CONFIG, {USER_DEFINE: USER_DEFINE})),
    );
    return sendMessageToTelegram('更新成功');
  } catch (e) {
    return sendMessageToTelegram(`設定項目の形式エラー： \`${e.message}\``);
  }
}

async function commandGenerateImg(message, command, subcommand) {
  if (subcommand==='') {
    return sendMessageToTelegram('画像の説明を入力してください。コマンドの完全な形式は \`/img 画像の説明\`です。');

  }
  try {
    setTimeout(() => sendChatActionToTelegram('upload_photo').catch(console.error), 0);
    const imgUrl =await requestImageFromOpenAI(subcommand);
    try {
      return sendPhotoToTelegram(imgUrl);
    } catch (e) {
      return sendMessageToTelegram(`画像:\n${imgUrl}`);
    }
  } catch (e) {
    return sendMessageToTelegram(`ERROR:IMG: ${e.message}`);
  }
}

// 命令帮助
async function commandGetHelp(message, command, subcommand) {
  const helpMsg =
      '現在、以下のコマンドがサポートされています:\n' +
      Object.keys(commandHandlers)
          .map((key) => `${key}：${commandHandlers[key].help}`)
          .join('\n');
  return sendMessageToTelegram(helpMsg);
}

// 新的会话
async function commandCreateNewChatContext(message, command, subcommand) {
  try {
    await DATABASE.delete(SHARE_CONTEXT.chatHistoryKey);
    if (command === '/new') {
      return sendMessageToTelegram('新しい会話が開始されました');
    } else {
      if (SHARE_CONTEXT.chatType==='private') {
        return sendMessageToTelegram(
            `新しい会話が開始されました、あなたのID(${CURRENT_CHAT_CONTEXT.chat_id})`,
        );
      } else {
        return sendMessageToTelegram(
            `新しい会話が開始されました、グループID(${CURRENT_CHAT_CONTEXT.chat_id})`,
        );
      }
    }
  } catch (e) {
    return sendMessageToTelegram(`ERROR: ${e.message}`);
  }
}

// 用户配置修改
async function commandUpdateUserConfig(message, command, subcommand) {
  const kv = subcommand.indexOf('=');
  if (kv === -1) {
    return sendMessageToTelegram(
        '設定項目のフォーマットが間違っています：コマンドの完全なフォーマットは/setenv KEY=VALUEです。',
    );
  }
  const key = subcommand.slice(0, kv);
  const value = subcommand.slice(kv + 1);
  try {
    mergeConfig(USER_CONFIG, key, value);
    await DATABASE.put(
        SHARE_CONTEXT.configStoreKey,
        JSON.stringify(USER_CONFIG),
    );
    return sendMessageToTelegram('更新に成功しました');
  } catch (e) {
    return sendMessageToTelegram(`設定項目の形式が正しくありません: ${e.message}`);
  }
}

async function commandFetchUpdate(message, command, subcommand) {
  const config = {
    headers: {
      'User-Agent': 'exveria1015/ChatGPT-Telegram-Workers',
    },
  };
  const current = {
    ts: ENV.BUILD_TIMESTAMP,
    sha: ENV.BUILD_VERSION,
  };
  const ts = `https://raw.githubusercontent.com/exveria1015/ChatGPT-Telegram-Workers/${ENV.UPDATE_BRANCH}/dist/timestamp`;
  const info = `https://raw.githubusercontent.com/exveria1015/ChatGPT-Telegram-Workers/${ENV.UPDATE_BRANCH}/dist/buildinfo.json`;
  let online = await fetch(info, config)
      .then((r) => r.json())
      .catch(() => null);
  if (!online) {
    online = await fetch(ts).then((r) => r.text())
        .then((ts) => ({ts: Number(ts.trim()), sha: 'unknown'}))
        .catch(() => ({ts: 0, sha: 'unknown'}));
  }

  if (current.ts < online.ts) {
    return sendMessageToTelegram(
        `発見した新しいバージョン。現在のバージョン: ${JSON.stringify(current)}、最新バージョン: ${JSON.stringify(online)}`,
    );
  } else {
    return sendMessageToTelegram(`現在のバージョンは最新です。現在のバージョン: ${JSON.stringify(current)}`);
  }
}


async function commandUsage() {
  if (!ENV.ENABLE_USAGE_STATISTICS) {
    return sendMessageToTelegram('現在、Botは利用統計を有効にしていません');
  }
  const usage = JSON.parse(await DATABASE.get(SHARE_CONTEXT.usageKey));
  let text = '📊 現在のBotの使用量\n\nTokens:\n';
  if (usage?.tokens) {
    const {tokens} = usage;
    const sortedChats = Object.keys(tokens.chats || {}).sort((a, b) => tokens.chats[b] - tokens.chats[a]);

    text += ` - 総使用量：${tokens.total || 0} tokens\n- 各チャットの使用量：`;
    for (let i = 0; i < Math.min(sortedChats.length, 30); i++) {
      text += `\n  - ${sortedChats[i]}: ${tokens.chats[sortedChats[i]]} tokens`;
    }
    if (sortedChats.length === 0) {
      text += '0 tokens';
    } else if (sortedChats.length > 30) {
      text += '\n  ...';
    }
  } else {
    text += '- 現在使用量はありません';
  }
  return sendMessageToTelegram(text);
}

async function commandSystem(message) {
  let msg = '現在のシステム情報は以下のとおりです:\n';
  msg+='OpenAI模型:'+ENV.CHAT_MODEL+'\n';
  if (ENV.DEBUG_MODE) {
    msg+='<pre>';
    msg+=`USER_CONFIG: \n${JSON.stringify(USER_CONFIG, null, 2)}\n`;
    if (ENV.DEV_MODE) {
      const shareCtx = {...SHARE_CONTEXT};
      shareCtx.currentBotToken = 'ENPYPTED';
      msg +=`CHAT_CONTEXT: \n${JSON.stringify(CURRENT_CHAT_CONTEXT, null, 2)}\n`;
      msg += `SHARE_CONTEXT: \n${JSON.stringify(shareCtx, null, 2)}\n`;
    }
    msg+='</pre>';
  }
  CURRENT_CHAT_CONTEXT.parse_mode = 'HTML';
  return sendMessageToTelegram(msg);
}

async function commandEcho(message) {
  let msg = '<pre>';
  msg += JSON.stringify({message}, null, 2);
  msg += '</pre>';
  CURRENT_CHAT_CONTEXT.parse_mode = 'HTML';
  return sendMessageToTelegram(msg);
}

export async function handleCommandMessage(message) {
  if (ENV.DEV_MODE) {
    commandHandlers['/echo'] = {
      help: '[DEBUG ONLY]エコーメッセージ',
      scopes: ['all_private_chats', 'all_chat_administrators'],
      fn: commandEcho,
      needAuth: commandAuthCheck.default,
    };
  }
  for (const key in commandHandlers) {
    if (message.text === key || message.text.startsWith(key + ' ')) {
      const command = commandHandlers[key];
      try {
        // 如果存在权限条件
        if (command.needAuth) {
          const roleList = command.needAuth();
          if (roleList) {
            // 获取身份并判断
            const chatRole = await getChatRole(SHARE_CONTEXT.speakerId);
            if (chatRole === null) {
              return sendMessageToTelegram('権限認証に失敗しました。');
            }
            if (!roleList.includes(chatRole)) {
              return sendMessageToTelegram(`権限が不足しています。必要なロール：${roleList.join(',')}。現在のロール：${chatRole}`);
            }
          }
        }
      } catch (e) {
        return sendMessageToTelegram(`Authentication Error::` + e.message);
      }
      const subcommand = message.text.substring(key.length).trim();
      try {
        return await command.fn(message, key, subcommand);
      } catch (e) {
        return sendMessageToTelegram(`コマンドが正しく実行できませんでした: ${e.message}`);
      }
    }
  }
  return null;
}

export async function bindCommandForTelegram(token) {
  const scopeCommandMap = {
    all_private_chats: [],
    all_group_chats: [],
    all_chat_administrators: [],
  };
  for (const key in commandHandlers) {
    if (ENV.HIDE_COMMAND_BUTTONS.includes(key)) {
      continue;
    }
    if (commandHandlers.hasOwnProperty(key) && commandHandlers[key].scopes) {
      for (const scope of commandHandlers[key].scopes) {
        if (!scopeCommandMap[scope]) {
          scopeCommandMap[scope] = [];
        }
        scopeCommandMap[scope].push(key);
      }
    }
  }

  const result = {};
  for (const scope in scopeCommandMap) { // eslint-disable-line
    result[scope] = await fetch(
        `https://api.telegram.org/bot${token}/setMyCommands`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            commands: scopeCommandMap[scope].map((command) => ({
              command,
              description: commandHandlers[command].help,
            })),
            scope: {
              type: scope,
            },
          }),
        },
    ).then((res) => res.json());
  }
  return {ok: true, result: result};
}


export function commandsDocument() {
  return Object.keys(commandHandlers).map((key) => {
    const command = commandHandlers[key];
    return {
      command: key,
      description: command.help,
    };
  });
}
