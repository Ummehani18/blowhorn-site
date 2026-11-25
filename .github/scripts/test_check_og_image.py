import unittest
from check_og_image import (
    DEFAULT_PATH,
    DEFAULT_WIDTH,
    DEFAULT_HEIGHT,
    TWITTER_CARD,
    TWITTER_SITE,
    MetaCollector,
    default_errors,
    article_errors,
    video_errors,
    role_errors,
)


def parse_html(html: str) -> MetaCollector:
    parser = MetaCollector()
    parser.feed(html)
    return parser


class DefaultErrorsTest(unittest.TestCase):
    def test_clean_default_page_passes(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="website">
          <meta name="twitter:site" content="{TWITTER_SITE}">
          <meta property="og:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
          <meta property="og:image:type" content="image/png">
          <meta property="og:image:width" content="{DEFAULT_WIDTH}">
          <meta property="og:image:height" content="{DEFAULT_HEIGHT}">
          <meta name="twitter:card" content="{TWITTER_CARD}">
          <meta name="twitter:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
        </head></html>
        """
        parser = parse_html(html)
        self.assertEqual(default_errors("index.html", parser, "https://blowhorn.ai/"), [])

    def test_missing_twitter_site_fails(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="website">
          <meta property="og:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
          <meta property="og:image:type" content="image/png">
          <meta property="og:image:width" content="{DEFAULT_WIDTH}">
          <meta property="og:image:height" content="{DEFAULT_HEIGHT}">
          <meta name="twitter:card" content="{TWITTER_CARD}">
          <meta name="twitter:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
        </head></html>
        """
        parser = parse_html(html)
        errs = default_errors("index.html", parser, "https://blowhorn.ai/")
        self.assertTrue(any("twitter:site" in e for e in errs), errs)

    def test_missing_og_image_type_fails(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="website">
          <meta name="twitter:site" content="{TWITTER_SITE}">
          <meta property="og:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
          <meta property="og:image:width" content="{DEFAULT_WIDTH}">
          <meta property="og:image:height" content="{DEFAULT_HEIGHT}">
          <meta name="twitter:card" content="{TWITTER_CARD}">
          <meta name="twitter:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
        </head></html>
        """
        parser = parse_html(html)
        errs = default_errors("index.html", parser, "https://blowhorn.ai/")
        self.assertTrue(any("og:image:type" in e for e in errs), errs)


class ArticleErrorsTest(unittest.TestCase):
    def test_clean_article_page_passes(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="article">
          <meta property="article:published_time" content="2026-10-30T00:00:00Z">
          <meta property="article:modified_time" content="2026-10-30T00:00:00Z">
          <meta name="author" content="Blowhorn team">
          <meta property="article:section" content="desk-of-the-general">
          <meta property="article:tag" content="agents">
          <meta name="twitter:site" content="{TWITTER_SITE}">
        </head></html>
        """
        parser = parse_html(html)
        self.assertEqual(article_errors("article.html", parser), [])

    def test_website_og_type_on_article_fails(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="website">
          <meta property="article:published_time" content="2026-10-30T00:00:00Z">
          <meta name="author" content="Blowhorn team">
          <meta property="article:tag" content="agents">
          <meta name="twitter:site" content="{TWITTER_SITE}">
        </head></html>
        """
        parser = parse_html(html)
        errs = article_errors("article.html", parser)
        self.assertTrue(any("og:type" in e and "article" in e for e in errs), errs)

    def test_missing_author_on_article_fails(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="article">
          <meta property="article:published_time" content="2026-10-30T00:00:00Z">
          <meta property="article:tag" content="agents">
          <meta name="twitter:site" content="{TWITTER_SITE}">
        </head></html>
        """
        parser = parse_html(html)
        errs = article_errors("article.html", parser)
        self.assertTrue(any("author" in e for e in errs), errs)


class VideoErrorsTest(unittest.TestCase):
    def test_clean_video_page_passes(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="video.other">
          <meta property="og:image" content="https://blowhorn.ai/assets/video/poster.webp">
          <meta property="og:image:type" content="image/webp">
          <meta name="twitter:card" content="{TWITTER_CARD}">
          <meta name="twitter:image" content="https://blowhorn.ai/assets/video/poster.webp">
          <meta name="twitter:site" content="{TWITTER_SITE}">
        </head></html>
        """
        parser = parse_html(html)
        self.assertEqual(video_errors("video.html", parser), [])

    def test_video_using_default_lockup_fails(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="video.other">
          <meta property="og:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
          <meta property="og:image:type" content="image/png">
          <meta name="twitter:card" content="{TWITTER_CARD}">
          <meta name="twitter:image" content="https://blowhorn.ai/{DEFAULT_PATH}">
          <meta name="twitter:site" content="{TWITTER_SITE}">
        </head></html>
        """
        parser = parse_html(html)
        errs = video_errors("video.html", parser)
        self.assertTrue(any("video pages keep their poster" in e for e in errs), errs)

    def test_video_with_wrong_og_type_fails(self):
        html = f"""
        <html><head>
          <meta property="og:type" content="website">
          <meta property="og:image" content="https://blowhorn.ai/assets/video/poster.webp">
          <meta property="og:image:type" content="image/webp">
          <meta name="twitter:site" content="{TWITTER_SITE}">
        </head></html>
        """
        parser = parse_html(html)
        errs = video_errors("video.html", parser)
        self.assertTrue(any("og:type" in e and "video.other" in e for e in errs), errs)


if __name__ == "__main__":
    unittest.main()
