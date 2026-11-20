// Настройки облачной синхронизации (Supabase).
// Оставьте пустыми — приложение будет работать локально, а мероприятия можно
// передавать ссылкой-снимком. Как подключить облако — см. README.md, раздел «Облако».
//
// anon-ключ публичный по своей природе: доступ к данным закрыт политиками RLS,
// а работать с мероприятием можно только зная его 128-битный id из ссылки.

export const SUPABASE_URL = 'https://xpquyxjaliyryfesapkt.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_oktZHxn9dAKLgvC7wl7-ug_l_H0NB4A'; // Settings → API Keys → Publishable key

// Как часто проверять изменения других участников, пока мероприятие открыто (мс)
export const POLL_INTERVAL = 8000;
