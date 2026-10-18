export const isMemberStatus = (member) =>
  member?.status === "creator" ||
  member?.status === "administrator" ||
  member?.status === "member" ||
  (member?.status === "restricted" && member.is_member === true);

export const fetchMembership = async (api, userId, chatId) =>
  isMemberStatus(await api.getChatMember(chatId, userId));
