# 上架到插件市场：还差的三步

市场（Awesome DSH Plugin / dsh-market）不接收"上传"，它读的是
`awesome-dsh-plugin/awesome-dsh-plugin` 仓库里的 `data/plugins/*.yml`。
所以上架 = **发布 npm 包 + 提一个只加一个 YAML 文件的 PR**。

## 0. 已完成（本地）

- 包名改成 `dsh-rea-tools`（`dsh-plugin-rea` 已被 [czcdr/dsh-plugin-rea](https://github.com/czcdr/dsh-plugin-rea) 占用）
- `private` 去掉、补 `license/repository/keywords/files/publishConfig`
- 打包体积 15.2 kB（7 个文件），`npm pack --dry-run` 通过
- 提交用的条目文件：`market/data__plugins__wangxun996__dsh-rea-tools.yml`

## 1. 建仓库（需要你的 GitHub）

```bash
cd /root/workspace/rea-dsh-plugin
git init -b main
git add -A && git commit -m "feat: dsh-rea-tools 0.1.0 — REA as DSH tools"
# 在 GitHub 建空仓库 dsh-rea-tools，然后：
git remote add origin git@github.com:wangxun996/dsh-rea-tools.git
git push -u origin main
```

然后给仓库加
`dsh-plugin` topic。市场要求**仓库创建满 1 天**才会被 CI 放行。

## 2. 发布 npm（需要你的 npm 账号）

```bash
npm login                     # 或者：echo "//registry.npmjs.org/:_authToken=..." >> ~/.npmrc
cd /root/workspace/rea-dsh-plugin
npm publish --access public
```

2026-11-16 状态：本机 `npm whoami` = `ENEEDAUTH`，所以**没有凭据时这一步做不了**。

## 3. 提 PR（需要你的 GitHub）

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cp /root/workspace/rea-dsh-plugin/market/data__plugins__wangxun996__dsh-rea-tools.yml \
   awesome-dsh-plugin/data/plugins/wangxun996__dsh-rea-tools.yml
cd awesome-dsh-plugin && git checkout -b add-dsh-rea-tools
git add data/plugins/wangxun996__dsh-rea-tools.yml && git commit -m "Add wangxun996/dsh-rea-tools"
git push -u origin add-dsh-rea-tools && gh pr create --fill
```

合并后通常一天内出现在市场里；装法就是 `dsh plugin --profile web add dsh-rea-tools`。

## 评审会核对什么

- `package.json` 里必须有 `dsh.bundle`（我们有 ✅），只有 `dsh.client` 会被拒
- 描述必须与代码一致：我们写的是"16 个工具 + 两个网关覆盖 255 个里的 239 个"，
  实际 `DEFAULT_DIRECT_TOOLS` 16 项、注册 18 个、上游目录 255 个 ✅
- 分类选贴合实际用途的（选 `tools`）
