import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type {
  CitationReference,
  CitationValidation,
  JsonRecord,
  NewsletterCollection,
  NewsletterDocument,
} from "../types/domain.js";
import { refineNewsletterVariant } from "./newsletterRefine.js";
import { buildXPostText, postToX, XPublishError } from "./xPublisher.js";

const SUPPORTED_EDITOR_LANGUAGES = new Set(["en", "tr"]);
const VARIANT_POST_STATUSES = new Set(["draft", "preauth", "authorized", "posted"]);

type NewsletterStatus = NewsletterDocument["status"];

export class NewsletterDocumentError extends Error {}

export class NewsletterStore {
  private readonly filePath: string;

  constructor(filePath = env.NEWSLETTER_NOSQL_PATH) {
    this.filePath = path.resolve(filePath);
  }

  private ensureFile() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ documents: [] }, null, 2));
    }
  }

  private readPayload(): { documents: NewsletterDocument[] } {
    this.ensureFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      if (!Array.isArray(parsed.documents)) {
        return { documents: [] };
      }
      return parsed;
    } catch (error) {
      throw new NewsletterDocumentError(`Failed to read newsletter store: ${String(error)}`);
    }
  }

  private writePayload(payload: { documents: NewsletterDocument[] }) {
    this.ensureFile();
    fs.writeFileSync(this.filePath, JSON.stringify(payload, null, 2));
  }

  private nowIso(): string {
    return new Date().toISOString();
  }

  private toLanguage(raw?: string | null): string {
    return (raw || "en").trim().toLowerCase() || "en";
  }

  private normalizeCitationId(raw?: string | null, index = 0): string {
    const candidate = String(raw || "").trim().toUpperCase();
    if (/^A\d+$/.test(candidate)) {
      return candidate;
    }
    return `A${index + 1}`;
  }

  private extractCitationIds(content: string): string[] {
    const matches = String(content || "").toUpperCase().match(/\[(A\d+)\]/g) ?? [];
    const normalized = matches.map((match) => match.replace(/[\[\]]/g, ""));
    return [...new Set(normalized)];
  }

  private ensureCitationCatalog(collection: JsonRecord): CitationReference[] {
    const existing = Array.isArray(collection.citation_catalog) ? collection.citation_catalog : [];
    const normalizedExisting = existing
      .map((item, idx) => ({
        citation_id: this.normalizeCitationId(String((item as any)?.citation_id || ""), idx),
        article_id: Number((item as any)?.article_id || 0),
        url: String((item as any)?.url || ""),
        title: String((item as any)?.title || ""),
      }))
      .filter((item) => item.article_id > 0 && item.url);

    if (normalizedExisting.length) {
      collection.citation_catalog = normalizedExisting;
      return normalizedExisting;
    }

    const news = Array.isArray(collection.news) ? collection.news : [];
    const derived = news.map((item, idx) => ({
      citation_id: this.normalizeCitationId(String((item as any)?.citation_id || ""), idx),
      article_id: Number((item as any)?.article_id || 0),
      url: String((item as any)?.url || ""),
      title: String((item as any)?.title || ""),
    }));
    collection.citation_catalog = derived;
    return derived;
  }

  private validateVariantCitations(collection: JsonRecord, variant: JsonRecord): CitationValidation {
    const catalog = this.ensureCitationCatalog(collection);
    const required = catalog.map((item) => item.citation_id);
    const markdown = String(variant.content_markdown || "");
    const text = String(variant.content_text || "");

    const tokenReferenced = new Set([
      ...this.extractCitationIds(markdown),
      ...this.extractCitationIds(text),
    ]);

    // Compatibility mode: if old drafts have no explicit citation tokens, infer references by URL.
    if (!tokenReferenced.size) {
      for (const item of catalog) {
        if (item.url && (markdown.includes(item.url) || text.includes(item.url))) {
          tokenReferenced.add(item.citation_id);
        }
      }
    }

    const referenced = [...tokenReferenced];
    const missing = required.filter((citation) => !tokenReferenced.has(citation));
    const orphan = referenced.filter((citation) => !required.includes(citation));
    const linkedRatio = required.length ? Number(((required.length - missing.length) / required.length).toFixed(4)) : 1;

    return {
      required_citations: required,
      referenced_citations: referenced,
      missing_citations: missing,
      orphan_citations: orphan,
      linked_ratio: linkedRatio,
      valid: missing.length === 0 && orphan.length === 0,
    };
  }

  private applyVariantCitationValidation(collection: JsonRecord, variant: JsonRecord): CitationValidation {
    const validation = this.validateVariantCitations(collection, variant);
    variant.citation_validation = validation;
    return validation;
  }

  private ensureDocumentCitationReadiness(doc: NewsletterDocument): void {
    for (const collection of doc.newsletter.news_collections as unknown as JsonRecord[]) {
      const variants = Array.isArray(collection.language_variants) ? collection.language_variants : [];
      if (!variants.length) {
        throw new NewsletterDocumentError(`Collection ${String(collection.collection_id || "unknown")} has no language variants`);
      }
      let hasValidVariant = false;
      for (const variant of variants as JsonRecord[]) {
        const validation = this.applyVariantCitationValidation(collection, variant);
        if (validation.valid) {
          hasValidVariant = true;
        }
      }
      if (!hasValidVariant) {
        throw new NewsletterDocumentError(
          `Collection ${String(collection.collection_id || "unknown")} is not citation-ready; add [A#] citations for all source articles`,
        );
      }
    }
  }

  private getStatus(doc: NewsletterDocument): NewsletterStatus {
    return doc.status;
  }

  private assertStatus(current: NewsletterStatus, allowed: NewsletterStatus[], action: string) {
    if (!allowed.includes(current)) {
      throw new NewsletterDocumentError(
        `Invalid transition for ${action}: current=${current}, allowed=${allowed.join(",")}`,
      );
    }
  }

  private audit(action: string, actor = "system", note?: string | null): JsonRecord {
    return { at: this.nowIso(), action, actor, note: note || undefined };
  }

  private normalizeNewsItem(news: JsonRecord): JsonRecord {
    return {
      article_id: Number(news.article_id || 0),
      citation_id: String(news.citation_id || ""),
      title: String(news.title || ""),
      url: String(news.url || ""),
      summary: String(news.summary || ""),
      topic: String(news.topic || "Other"),
      language: String(news.language || "unknown"),
      published_at: news.published_at || null,
    };
  }

  private ensureVariant(collection: JsonRecord, language: string): JsonRecord {
    const variants = Array.isArray(collection.language_variants) ? collection.language_variants : [];
    collection.language_variants = variants;
    let variant = variants.find((item) => String(item.language || "").toLowerCase() === language);
    if (!variant) {
      variant = {
        language,
        headline: "",
        content_markdown: "",
        content_text: "",
        tone: "neutral",
        context_level: "standard",
        post_status: "draft",
        approved_at: null,
        posted_at: null,
        updated_at: this.nowIso(),
        citation_validation: {
          required_citations: [],
          referenced_citations: [],
          missing_citations: [],
          orphan_citations: [],
          linked_ratio: 1,
          valid: true,
        },
      };
      variants.push(variant);
    }
    return variant;
  }

  private variantPostStatus(variant: JsonRecord, docStatus?: NewsletterStatus): "draft" | "preauth" | "authorized" | "posted" {
    const raw = String(variant.post_status || "").trim().toLowerCase();
    if (VARIANT_POST_STATUSES.has(raw)) {
      return raw as "draft" | "preauth" | "authorized" | "posted";
    }

    if (docStatus === "posted") return "posted";
    return "draft";
  }

  private setVariantPostStatus(
    variant: JsonRecord,
    status: "draft" | "preauth" | "authorized" | "posted",
    options?: { approvedAt?: string | null; postedAt?: string | null },
  ) {
    variant.post_status = status;
    if (status === "authorized") {
      variant.approved_at = options?.approvedAt ?? this.nowIso();
    } else if (status === "posted") {
      variant.posted_at = options?.postedAt ?? this.nowIso();
      variant.approved_at = options?.approvedAt ?? String(variant.approved_at || this.nowIso());
    } else {
      variant.approved_at = options?.approvedAt ?? null;
      variant.posted_at = options?.postedAt ?? null;
    }
  }

  private markVariantDraft(variant: JsonRecord) {
    this.setVariantPostStatus(variant, "draft");
  }

  private markVariantPreAuth(variant: JsonRecord) {
    this.setVariantPostStatus(variant, "preauth");
  }

  private ensureVersions(doc: NewsletterDocument): JsonRecord[] {
    if (!Array.isArray(doc.versions)) {
      doc.versions = [];
    }
    return doc.versions as JsonRecord[];
  }

  private appendVersion(
    doc: NewsletterDocument,
    collectionId: string,
    language: string,
    variant: JsonRecord,
    action: string,
    actor: string,
    note?: string,
  ) {
    const versions = this.ensureVersions(doc);
    versions.push({
      version_id: crypto.randomUUID(),
      at: this.nowIso(),
      collection_id: collectionId,
      language,
      headline: String(variant.headline || ""),
      content_markdown: String(variant.content_markdown || ""),
      content_text: String(variant.content_text || ""),
      tone: String(variant.tone || "neutral"),
      context_level: String(variant.context_level || "standard"),
      post_status: this.variantPostStatus(variant, doc.status),
      citation_validation: variant.citation_validation || null,
      action,
      actor,
      note,
    });

    if (versions.length > 500) {
      versions.splice(0, versions.length - 500);
    }
  }

  listDocuments(status?: string, limit = 50, offset = 0) {
    const payload = this.readPayload();
    let docs = [...payload.documents];
    if (status) {
      docs = docs.filter((item) => item.status === status);
    }
    docs.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

    return {
      items: docs.slice(offset, offset + limit),
      total: docs.length,
    };
  }

  latestDocument() {
    return this.listDocuments(undefined, 1, 0).items[0] || null;
  }

  getDocument(documentId: string): NewsletterDocument | null {
    const payload = this.readPayload();
    return payload.documents.find((item) => item.id === documentId) || null;
  }

  upsertPipelineDraft(args: {
    runId: string;
    postDate: string;
    dailyPostId: number;
    outputLanguage: string;
    headline: string;
    contentMarkdown: string;
    contentText: string;
    selectedNews: JsonRecord[];
    citationCatalog?: CitationReference[];
  }): NewsletterDocument {
    const payload = this.readPayload();
    const language = SUPPORTED_EDITOR_LANGUAGES.has(this.toLanguage(args.outputLanguage))
      ? this.toLanguage(args.outputLanguage)
      : "en";

    const collectionId = `collection-${args.postDate}`;
    let doc = payload.documents.find(
      (item) => item.daily_post_id === args.dailyPostId || item.post_date === args.postDate,
    );

    if (!doc) {
      doc = {
        id: crypto.randomUUID(),
        post_date: args.postDate,
        daily_post_id: args.dailyPostId,
        pipeline_run_id: args.runId,
        status: "draft",
        created_at: this.nowIso(),
        updated_at: this.nowIso(),
        newsletter: {
          newsletter_id: `newsletter-${args.postDate}`,
          news_collections: [],
        },
        x_publish: {
          posted: false,
          tweet_id: null,
          url: null,
          posted_at: null,
          dedupe_key: null,
          correlation_id: null,
        },
        versions: [],
        audit: [],
      };
      payload.documents.push(doc);
    }

    const collections = doc.newsletter.news_collections;
    let collection: NewsletterCollection | undefined = collections.find((item) => item.collection_id === collectionId);
    if (!collection) {
      collection = { collection_id: collectionId, news: [], language_variants: [] };
      collections.push(collection);
    }

    collection.news = args.selectedNews.map((item) => this.normalizeNewsItem(item));
    const derivedCatalog = collection.news.map((item, idx) => ({
      citation_id: this.normalizeCitationId(String(item.citation_id || ""), idx),
      article_id: Number(item.article_id || 0),
      url: String(item.url || ""),
      title: String(item.title || ""),
    }));
    collection.citation_catalog = (args.citationCatalog && args.citationCatalog.length
      ? args.citationCatalog
      : derivedCatalog).map((item, idx) => ({
      citation_id: this.normalizeCitationId(item.citation_id, idx),
      article_id: Number(item.article_id || 0),
      url: String(item.url || ""),
      title: String(item.title || ""),
    }));
    const variant = this.ensureVariant(collection as unknown as JsonRecord, language);
    Object.assign(variant, {
      language,
      headline: args.headline,
      content_markdown: args.contentMarkdown,
      content_text: args.contentText,
      updated_at: this.nowIso(),
    });
    this.markVariantPreAuth(variant);
    this.applyVariantCitationValidation(collection as unknown as JsonRecord, variant);

    this.appendVersion(doc, collectionId, language, variant, "pipeline_draft", "pipeline");

    doc.pipeline_run_id = args.runId;
    doc.status = "draft";
    doc.updated_at = this.nowIso();
    doc.audit.push(this.audit("draft_persisted_from_pipeline", "pipeline"));

    this.writePayload(payload);
    return doc;
  }

  saveDraft(args: {
    documentId: string;
    collectionId: string;
    language: string;
    headline: string;
    contentMarkdown: string;
    contentText: string;
    tone: string;
    contextLevel: string;
    note?: string | null;
  }): NewsletterDocument {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === args.documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    const status = this.getStatus(doc);
    if (["posted", "deleted"].includes(status)) {
      throw new NewsletterDocumentError(`Newsletter document in status '${status}' cannot be edited`);
    }

    const collection = doc.newsletter.news_collections.find((item) => item.collection_id === args.collectionId);
    if (!collection) {
      throw new NewsletterDocumentError(`Collection not found: ${args.collectionId}`);
    }

    const lang = this.toLanguage(args.language);
    if (!SUPPORTED_EDITOR_LANGUAGES.has(lang)) {
      throw new NewsletterDocumentError("Editor currently supports only en and tr");
    }

    const variant = this.ensureVariant(collection as unknown as JsonRecord, lang);
    Object.assign(variant, {
      language: lang,
      headline: args.headline.trim(),
      content_markdown: args.contentMarkdown.trim(),
      content_text: args.contentText.trim(),
      tone: (args.tone || "neutral").trim().toLowerCase(),
      context_level: (args.contextLevel || "standard").trim().toLowerCase(),
      updated_at: this.nowIso(),
    });
    this.markVariantDraft(variant);
    this.applyVariantCitationValidation(collection as unknown as JsonRecord, variant);

    this.appendVersion(doc, args.collectionId, lang, variant, "save_draft", "user", args.note || undefined);

    doc.status = "draft";
    doc.updated_at = this.nowIso();
    doc.audit.push(this.audit("draft_saved", "user", args.note));
    this.writePayload(payload);

    return doc;
  }

  async refineWithChatbot(args: {
    documentId: string;
    collectionId: string;
    sourceLanguage: string;
    targetLanguage: string;
    tone: string;
    contextLevel: string;
    userInstruction?: string | null;
  }): Promise<NewsletterDocument> {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === args.documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    const status = this.getStatus(doc);
    if (["posted", "deleted"].includes(status)) {
      throw new NewsletterDocumentError(`Newsletter document in status '${status}' cannot be refined`);
    }

    const collection = doc.newsletter.news_collections.find((item) => item.collection_id === args.collectionId);
    if (!collection) {
      throw new NewsletterDocumentError(`Collection not found: ${args.collectionId}`);
    }

    const src = this.toLanguage(args.sourceLanguage);
    const target = this.toLanguage(args.targetLanguage);
    if (!SUPPORTED_EDITOR_LANGUAGES.has(src) || !SUPPORTED_EDITOR_LANGUAGES.has(target)) {
      throw new NewsletterDocumentError("Chat editor currently supports only en and tr");
    }

    const sourceVariant = (collection.language_variants || []).find(
      (item) => String(item.language || "").toLowerCase() === src,
    );
    if (!sourceVariant) {
      throw new NewsletterDocumentError(`Source language variant not found: ${src}`);
    }

    const citationCatalog = this.ensureCitationCatalog(collection as unknown as JsonRecord);
    const sourceArticles = (Array.isArray(collection.news) ? collection.news : []).map((item, index) => ({
      citation_id: this.normalizeCitationId(String((item as JsonRecord).citation_id || ""), index),
      title: String((item as JsonRecord).title || ""),
      url: String((item as JsonRecord).url || ""),
      summary: String((item as JsonRecord).summary || ""),
    }));
    const refined = await refineNewsletterVariant({
      sourceLanguage: src,
      targetLanguage: target,
      tone: args.tone,
      contextLevel: args.contextLevel,
      userInstruction: args.userInstruction,
      sourceHeadline: String(sourceVariant.headline || "").trim(),
      sourceMarkdown: String(sourceVariant.content_markdown || "").trim(),
      sourceText: String(sourceVariant.content_text || "").trim(),
      citationCatalog: citationCatalog as CitationReference[],
      sourceArticles,
    });

    const targetVariant = this.ensureVariant(collection as unknown as JsonRecord, target);
    Object.assign(targetVariant, {
      language: target,
      headline: refined.headline,
      content_markdown: refined.contentMarkdown,
      content_text: refined.contentText,
      tone: (args.tone || "neutral").toLowerCase(),
      context_level: (args.contextLevel || "standard").toLowerCase(),
      updated_at: this.nowIso(),
    });
    this.markVariantPreAuth(targetVariant);
    this.applyVariantCitationValidation(collection as unknown as JsonRecord, targetVariant);

    this.appendVersion(
      doc,
      args.collectionId,
      target,
      targetVariant,
      "chat_refine",
      "user",
      args.userInstruction
        ? `provider=${refined.provider} | ${args.userInstruction}`
        : `provider=${refined.provider}`,
    );

    doc.status = "draft";
    doc.updated_at = this.nowIso();
    doc.audit.push(this.audit("chat_refine", "user", `${src}->${target}; provider=${refined.provider}`));
    this.writePayload(payload);
    return doc;
  }

  listVersions(args: {
    documentId: string;
    collectionId?: string;
    language?: string;
    limit?: number;
    offset?: number;
  }) {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === args.documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    let versions = [...this.ensureVersions(doc)];
    if (args.collectionId) {
      versions = versions.filter((item) => item.collection_id === args.collectionId);
    }
    if (args.language) {
      versions = versions.filter((item) => String(item.language || "").toLowerCase() === this.toLanguage(args.language));
    }

    versions.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    const offset = Math.max(0, args.offset || 0);
    const limit = Math.max(1, Math.min(args.limit || 20, 500));

    return { items: versions.slice(offset, offset + limit), total: versions.length };
  }

  rollbackToVersion(args: { documentId: string; versionId: string; note?: string | null }): NewsletterDocument {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === args.documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    this.assertStatus(doc.status, ["draft", "authorized"], "rollback");

    const version = this.ensureVersions(doc).find((item) => String(item.version_id) === args.versionId);
    if (!version) {
      throw new NewsletterDocumentError(`Version not found: ${args.versionId}`);
    }

    const collectionId = String(version.collection_id || "");
    const language = this.toLanguage(String(version.language || "en"));

    const collection = doc.newsletter.news_collections.find((item) => item.collection_id === collectionId);
    if (!collection) {
      throw new NewsletterDocumentError(`Collection not found: ${collectionId}`);
    }

    const variant = this.ensureVariant(collection as unknown as JsonRecord, language);
    Object.assign(variant, {
      language,
      headline: String(version.headline || ""),
      content_markdown: String(version.content_markdown || ""),
      content_text: String(version.content_text || ""),
      tone: String(version.tone || "neutral"),
      context_level: String(version.context_level || "standard"),
      updated_at: this.nowIso(),
    });
    this.markVariantDraft(variant);
    this.applyVariantCitationValidation(collection as unknown as JsonRecord, variant);

    this.appendVersion(
      doc,
      collectionId,
      language,
      variant,
      "rollback",
      "user",
      args.note ? `${args.note} | rollback_from=${args.versionId}` : `rollback_from=${args.versionId}`,
    );

    doc.status = "draft";
    doc.updated_at = this.nowIso();
    doc.audit.push(this.audit("rollback", "user", args.note || `version_id=${args.versionId}`));

    this.writePayload(payload);
    return doc;
  }

  authorize(
    documentId: string,
    note?: string | null,
    options?: { collectionId?: string; language?: string },
  ): NewsletterDocument {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    this.assertStatus(doc.status, ["draft", "authorized"], "authorize");
    this.ensureDocumentCitationReadiness(doc);

    const targetCollectionId = options?.collectionId ? String(options.collectionId) : null;
    const targetLanguage = options?.language ? this.toLanguage(options.language) : null;

    const targets: Array<{ collectionId: string; language: string; variant: JsonRecord; collection: JsonRecord }> = [];
    for (const collection of doc.newsletter.news_collections as unknown as JsonRecord[]) {
      const collectionId = String(collection.collection_id || "");
      if (targetCollectionId && collectionId !== targetCollectionId) continue;

      const variants = Array.isArray(collection.language_variants) ? (collection.language_variants as JsonRecord[]) : [];
      for (const variant of variants) {
        const lang = this.toLanguage(String(variant.language || "en"));
        if (targetLanguage && lang !== targetLanguage) continue;
        targets.push({ collectionId, language: lang, variant, collection });
      }
    }

    if (!targets.length) {
      if (targetCollectionId && targetLanguage) {
        throw new NewsletterDocumentError(`Language variant not found: ${targetCollectionId}/${targetLanguage}`);
      }
      throw new NewsletterDocumentError("No language variants found for authorization");
    }

    let authorizedCount = 0;
    for (const target of targets) {
      const validation = this.applyVariantCitationValidation(target.collection, target.variant);
      if (!validation.valid) {
        throw new NewsletterDocumentError(
          `Cannot authorize ${target.collectionId}/${target.language}: missing=${validation.missing_citations.join(",") || "none"} orphan=${validation.orphan_citations.join(",") || "none"}`,
        );
      }

      if (this.variantPostStatus(target.variant, doc.status) !== "posted") {
        this.setVariantPostStatus(target.variant, "authorized", { approvedAt: this.nowIso() });
        authorizedCount += 1;
      }
    }

    doc.status = "authorized";
    doc.updated_at = this.nowIso();
    if (targetCollectionId && targetLanguage) {
      doc.audit.push(
        this.audit(
          "status:authorized",
          "user",
          note ? `${note} | ${targetCollectionId}/${targetLanguage}` : `${targetCollectionId}/${targetLanguage}`,
        ),
      );
    } else if (authorizedCount > 0) {
      doc.audit.push(this.audit("status:authorized", "user", note ? `${note} | all_variants` : "all_variants"));
    } else {
      doc.audit.push(this.audit("citation_validation_checked", "system"));
    }
    this.writePayload(payload);
    return doc;
  }

  markManualPosted(documentId: string, note?: string | null): NewsletterDocument {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    this.assertStatus(doc.status, ["draft", "authorized", "manual_posted"], "manual_posted");
    if (doc.status === "manual_posted") {
      return doc;
    }

    doc.status = "manual_posted";
    doc.updated_at = this.nowIso();
    doc.audit.push(this.audit("status:manual_posted", "user", note));
    this.writePayload(payload);
    return doc;
  }

  markDeleted(documentId: string, note?: string | null): NewsletterDocument {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    this.assertStatus(doc.status, ["draft", "authorized", "manual_posted", "deleted"], "delete");
    if (doc.status === "deleted") {
      return doc;
    }

    doc.status = "deleted";
    doc.updated_at = this.nowIso();
    doc.newsletter.news_collections = [];
    doc.audit.push(this.audit("status:deleted", "user", note));
    this.writePayload(payload);
    return doc;
  }

  private publishDedupeKey(documentId: string, collectionId: string, language: string, postText: string) {
    const canonical = [documentId, collectionId, language.toLowerCase(), postText.trim()].join("|");
    return crypto.createHash("sha256").update(canonical).digest("hex");
  }

  async postDocumentToX(args: {
    documentId: string;
    collectionId: string;
    language: string;
    note?: string | null;
  }): Promise<NewsletterDocument> {
    const payload = this.readPayload();
    const doc = payload.documents.find((item) => item.id === args.documentId);
    if (!doc) {
      throw new NewsletterDocumentError("Newsletter document not found");
    }

    if (!["authorized", "posted"].includes(doc.status)) {
      throw new NewsletterDocumentError("Newsletter must be authorized before posting to X");
    }

    const collection = doc.newsletter.news_collections.find((item) => item.collection_id === args.collectionId);
    if (!collection) {
      throw new NewsletterDocumentError(`Collection not found: ${args.collectionId}`);
    }

    const language = this.toLanguage(args.language);
    const variant = (collection.language_variants || []).find(
      (item) => String(item.language || "").toLowerCase() === language,
    );

    if (!variant) {
      throw new NewsletterDocumentError(`Language variant not found: ${language}`);
    }
    const validation = this.applyVariantCitationValidation(collection as unknown as JsonRecord, variant as unknown as JsonRecord);
    if (!validation.valid) {
      throw new NewsletterDocumentError(
        `Cannot post to X: citation validation failed (missing=${validation.missing_citations.join(",") || "none"} orphan=${validation.orphan_citations.join(",") || "none"})`,
      );
    }
    const variantStatus = this.variantPostStatus(variant as unknown as JsonRecord, doc.status);
    if (!["authorized", "posted"].includes(variantStatus)) {
      throw new NewsletterDocumentError(`Language variant must be authorized before posting to X (${language})`);
    }

    const postText = buildXPostText(String(variant.headline || ""), String(variant.content_text || ""), language);
    const dedupeKey = this.publishDedupeKey(doc.id, args.collectionId, language, postText);

    if (doc.status === "posted" && doc.x_publish?.posted) {
      const existingKey = String(doc.x_publish?.dedupe_key || "").trim();
      if (!existingKey || existingKey === dedupeKey) {
        return doc;
      }
      throw new NewsletterDocumentError(
        "Newsletter already posted with different content; save/edit as draft and re-authorize before reposting",
      );
    }

    let posted;
    try {
      posted = await postToX(postText);
    } catch (error) {
      if (error instanceof XPublishError) {
        throw new NewsletterDocumentError(error.message);
      }
      throw error;
    }

    doc.status = "posted";
    this.setVariantPostStatus(variant as unknown as JsonRecord, "posted", { postedAt: posted.postedAt });
    doc.updated_at = this.nowIso();
    doc.x_publish = {
      posted: true,
      tweet_id: posted.tweetId,
      url: posted.url,
      posted_at: posted.postedAt,
      dedupe_key: dedupeKey,
      correlation_id: crypto.randomUUID(),
    };
    doc.audit.push(
      this.audit(
        "status:posted",
        "system",
        args.note
          ? `${args.note} | dedupe_key=${doc.x_publish.dedupe_key} correlation_id=${doc.x_publish.correlation_id}`
          : `dedupe_key=${doc.x_publish.dedupe_key} correlation_id=${doc.x_publish.correlation_id}`,
      ),
    );

    this.writePayload(payload);
    return doc;
  }
}

let singleton: NewsletterStore | null = null;

export function newsletterStore() {
  if (!singleton) {
    singleton = new NewsletterStore();
  }
  return singleton;
}
