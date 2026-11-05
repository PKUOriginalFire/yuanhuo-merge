# 活动与岗位素材

已接入桌面“元火美术资源”提供的 11 张图片，以及用户在“爱蒂塔计划”群提供的秋季招新海报，共 12 张。活动和夜奔图片按人物位置铺满圆形，元火标志保留完整轮廓并填充圆形背景；岗位使用圆形简称。

## 替换活动海报

文件放在本目录下，支持 `.webp` 和 `.png`；同名两种格式都登记时优先使用 `.webp`。

| 等级 | 内容 | 相对本目录的路径 |
| --- | --- | --- |
| 1 | 秋季百团迎新 | `activities/autumn-welcome.webp` |
| 2 | 迎新晚会 | `activities/welcome-gala.webp` |
| 3 | 高端讲座 | `activities/lecture.webp` |
| 4 | 乐队专场 | `activities/band-live.webp` |
| 5 | V家例会 | `activities/vocaloid-meeting.webp` |
| 6 | 东方例会 | `activities/touhou-meeting.webp` |
| 7 | COS咖啡厅 | `activities/cos-cafe.webp` |
| 8 | 春季百团迎新 | `activities/spring-welcome.webp` |
| 9 | 春季晚会 | `activities/spring-gala.webp` |
| 10 | 社庆 | `activities/anniversary.webp` |
| 11 | 元火标志 | `activities/yuanhuo-logo.webp` |

正式图会按 `tools/artwork.json` 指定的原图区域铺满圆形，优先保留两人的脸；没有配置的图片默认居中裁切。运行 `npm run assets:import` 生成最长边不超过 2560 像素的 WebP 副本、`src/art-crops.json`，并生成 `sprites/<ID>.webp` 的 512 像素圆形小图；原海报不变。原图尺寸、来源校验值与裁切记录见 `docs/art-import-20261014.json`。也可单独用 `npm run assets:sprites` 从现有副本重新生成小图。

秋季招新原件留在 `%TEMP%/dsh-qq/autumn-welcome-9656C5F9.png`，配置的 `sourceDirectory: "qq-cache"` 表示从该缓存读取；不将群聊历史保存到项目或发布包。生成的 WebP 副本已包含在项目中，常规构建不需要重新读取 QQ 或原件。

## 岗位与隐藏球

岗位可以持续使用圆形文字。若替换，依次使用 `roles/animation.webp`、`roles/publicity.webp`、`roles/organization.webp`、`roles/practice.webp`、`roles/cos.webp`、`roles/technology.webp`、`roles/daily-vice.webp`、`roles/outreach-vice.webp`、`roles/venue-finance-vice.webp`、`roles/activities-vice.webp`、`roles/president.webp`。

隐藏球路径是 `secrets/night-run.webp`（医学部夜奔）和 `secrets/stage.webp`（舞台部），也可使用同名 `.png`。

## 素材清单

加载器读取 `manifest.json`，路径相对本目录。只有清单内的图片会被请求，空清单直接使用占位；清单缺失、格式错误或超时同样使用占位。

```json
{
  "files": [
    "activities/autumn-welcome.webp",
    "secrets/night-run.png"
  ]
}
```

添加或替换正式图片后，构建流程自动登记实际图片并生成内容版本号。清单超时上限为 5 秒，单张图片为 15 秒，全部内容并行加载，已登记但加载失败的图片只在控制台简洁记录。

首页与游戏不等待所有图片完成。游戏优先请求圆形小图（12 张共 448,936 字节），小图失败才尝试完整副本。清单的 `versions` 保存每个文件的独立内容 hash，仅该图片发生变化时更新 URL，不因其他图片修改而清空整个素材缓存。未知图鉴不绘制真实图片，也不能打开介绍。

可选场地与效果图保留 `bg.webp`、`logo.webp`、`over.webp`、`halo.webp`、`spark.webp`，也支持同名 `.png`。场地尺寸和边界须与 `src/config.ts` 的 `WORLD`、`CONTAINER` 一致。名称、简介和稳定收藏 ID 集中在 `src/catalog.ts`；简介当前统一为“介绍待补充。”，后续补文案时保留 ID。
