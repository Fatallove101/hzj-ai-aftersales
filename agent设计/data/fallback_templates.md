# 兜底话术模板（降级与 insufficient 场景专用）

> **使用条件**：仅在以下两种情况使用，且**必须同时 `need_human = true`**：
> 1. 话术生成 Agent 失败或返回空结果（`fallback = true`）
> 2. `coverage == "insufficient"`（检索无据）
>
> **共同约束**：兜底话术**不得包含**任何政策期限、赔偿金额、责任归属、运费承担方的表述。
> 它们只做两件事：**接住情绪** + **给出下一步**。

---

## 按 primary_intent 的兜底模板

### refund / quality_defect / color_diff
- **中文**：非常抱歉给您带来不好的体验，您反馈的问题我们已经记录并正在核实。为了尽快为您处理，方便的话请提供一下实物照片。我们会第一时间告知您处理方案。
- **English**: I'm very sorry about your experience. We've logged the issue you reported and are checking it now. To help us move faster, could you send us a photo of the item? We'll get back to you with a solution as soon as we can.
- **Español**: Lamento mucho las molestias. Hemos registrado su incidencia y la estamos revisando. Para agilizar el proceso, ¿podría enviarnos una foto del artículo? Le informaremos de la solución lo antes posible.
- **Deutsch**: Es tut uns sehr leid. Wir haben Ihr Anliegen aufgenommen und prüfen es derzeit. Damit wir schneller helfen können, könnten Sie uns bitte ein Foto des Artikels senden? Wir melden uns schnellstmöglich mit einer Lösung.
- **Français**: Nous sommes désolés pour cette expérience. Nous avons enregistré votre problème et nous le vérifions. Pour accélérer le traitement, pourriez-vous nous envoyer une photo de l'article ? Nous reviendrons vers vous dès que possible.

### logistics
- **中文**：感谢您的耐心等待。我们正在为您查询包裹的最新状态，稍后会同步给您。如果物流确认异常，我们会立即为您安排后续处理。
- **English**: Thank you for your patience. We're checking the latest status of your parcel and will update you shortly. If the carrier confirms an issue, we'll arrange a follow-up for you right away.
- **Español**: Gracias por su paciencia. Estamos consultando el estado más reciente de su paquete y se lo comunicaremos en breve. Si el transportista confirma una incidencia, gestionaremos una solución de inmediato.
- **Deutsch**: Vielen Dank für Ihre Geduld. Wir prüfen den aktuellen Status Ihres Pakets und melden uns in Kürze. Sollte der Versanddienstleister ein Problem bestätigen, veranlassen wir umgehend eine Lösung.
- **Français**: Merci pour votre patience. Nous vérifions le dernier statut de votre colis et vous tiendrons informé rapidement. Si le transporteur confirme une anomalie, nous organiserons immédiatement une solution.

### exchange / sizing
- **中文**：感谢您的反馈。关于尺码或更换的问题，我们已经记录，正在核对相关信息。请稍等，我们会尽快给您明确的处理方式。
- **English**: Thank you for your feedback. We've noted your request about sizing or an exchange and are verifying the details. Please bear with us — we'll come back to you with a clear option shortly.
- **Español**: Gracias por su mensaje. Hemos registrado su consulta sobre la talla o el cambio y estamos verificando los detalles. En breve le daremos una opción concreta.
- **Deutsch**: Vielen Dank für Ihre Nachricht. Wir haben Ihr Anliegen zu Größe oder Umtausch erfasst und prüfen die Details. Wir melden uns in Kürze mit einer konkreten Option.
- **Français**: Merci pour votre message. Nous avons noté votre demande concernant la taille ou un échange et nous vérifions les détails. Nous reviendrons vers vous rapidement avec une solution concrète.

### negative_review / complaint_service
- **中文**：非常抱歉没有让您满意。您反馈的情况我们已经上报，会由专人跟进核实。我们会尽快给您答复，也感谢您愿意给我们改进的机会。
- **English**: We're truly sorry we didn't meet your expectations. Your feedback has been escalated and a dedicated colleague will look into it. We'll get back to you as soon as possible, and thank you for giving us the chance to improve.
- **Español**: Sentimos mucho no haber estado a la altura. Su caso ha sido escalado y un compañero dedicado lo revisará. Le responderemos lo antes posible y le agradecemos la oportunidad de mejorar.
- **Deutsch**: Es tut uns aufrichtig leid, dass wir Ihre Erwartungen nicht erfüllt haben. Ihr Fall wurde weitergegeben und wird von einer zuständigen Kollegin oder einem Kollegen geprüft. Wir melden uns schnellstmöglich und danken Ihnen für die Chance zur Verbesserung.
- **Français**: Nous sommes sincèrement désolés de ne pas avoir été à la hauteur. Votre dossier a été transmis et sera examiné par une personne dédiée. Nous vous répondrons dans les plus brefs délais, et merci de nous donner l'occasion de nous améliorer.

### customs / invoice / payment
- **中文**：感谢您的联系。关于您提到的问题，我们需要核对订单信息后再给您准确答复。我们正在处理，请稍候，会尽快回复您。
- **English**: Thank you for reaching out. To give you an accurate answer on this, we need to verify your order details. We're on it and will reply as soon as possible.
- **Español**: Gracias por contactarnos. Para darle una respuesta precisa, necesitamos verificar los datos de su pedido. Estamos en ello y le responderemos lo antes posible.
- **Deutsch**: Vielen Dank für Ihre Nachricht. Um Ihnen eine genaue Antwort geben zu können, müssen wir Ihre Bestelldaten prüfen. Wir kümmern uns darum und antworten so schnell wie möglich.
- **Français**: Merci de nous avoir contactés. Pour vous répondre précisément, nous devons vérifier les informations de votre commande. Nous nous en occupons et vous répondrons dès que possible.

### other（通用兜底）
- **中文**：感谢您的留言，我们已经收到您的问题，正在为您核实。我们会尽快回复您。
- **English**: Thank you for your message. We've received your question and are looking into it. We'll get back to you shortly.
- **Español**: Gracias por su mensaje. Hemos recibido su consulta y la estamos revisando. Le responderemos en breve.
- **Deutsch**: Vielen Dank für Ihre Nachricht. Wir haben Ihre Frage erhalten und prüfen sie. Wir melden uns in Kürze bei Ihnen.
- **Français**: Merci pour votre message. Nous avons bien reçu votre question et nous la vérifions. Nous vous répondrons rapidement.

---

## 禁止出现在兜底话术中的表述

| 禁止表述 | 原因 |
|---|---|
| "我们保证 3 天内退款" | 时效承诺，无政策依据不得给 |
| "一定会全额赔偿您" | 金额与范围承诺 |
| "这肯定是物流的问题" | 责任归属结论 |
| "根据欧盟法律您有 14 天…" | 兜底场景无检索证据，不得引用政策 |
| "运费我们承担" | 费用承诺（即使多数场景成立，无证据时也不得说） |
| "平台会判我们退款" | 替平台下判罚结论 |
| "加我微信…" | 站外引流 |

---

## 客服工作台的兜底展示要求

当兜底话术被使用时，工作台必须：
1. 在话术卡片上显示醒目的**黄色/红色标记**："本次为通用话术，未匹配到知识依据，请人工确认后再发送"。
2. 同时显示 **转人工按钮**（`need_human = true` 必然为真）。
3. 显示 `handoff_packet`，特别是"已检索但未命中"的 query，让客服知道 AI 尝试过什么。
4. 在主控输出的 `final.knowledge_gaps` 中记录本次缺口，供数据闭环 Agent 汇总。

> **设计意图**：兜底话术是"安全网"，不是"默认路径"。
> 如果兜底话术的使用率超过 10%，说明知识库建设或检索环节出了系统性问题，
> 应当作为 P0 项处理，而不是让兜底话术长期替代真实能力。
