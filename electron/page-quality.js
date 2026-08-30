function isBlockedPage(title, text) {
  const sample = `${title || ""}\n${String(text || "").slice(0, 500)}`;
  return /安全验证|请进行验证|请进行安全验证|滑动验证|人机验证|访问验证|security verification|unusual traffic|captcha/i.test(
    sample,
  );
}

module.exports = {
  isBlockedPage,
};
