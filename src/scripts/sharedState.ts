// This map will be shared between your bot and auth server
// to track who is trying to link their account.
export const pendingAuth = new Map<string, string>();