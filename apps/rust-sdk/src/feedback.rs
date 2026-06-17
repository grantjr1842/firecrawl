//! Feedback endpoint for Firecrawl API v2.
//!
//! Provides the ability to submit feedback for scrape / search / parse / map
//! jobs (used for credit refunds) and search-specific feedback against a
//! search job id.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::client::Client;
use crate::FirecrawlError;

/// The qualitative rating for a feedback submission.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackRating {
    /// Result was fully useful.
    Good,
    /// Result was partially useful.
    Partial,
    /// Result was not useful.
    Bad,
}

/// Endpoint categories accepted by the generic feedback endpoint.
#[derive(Deserialize, Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackEndpoint {
    /// `/v2/search` job.
    Search,
    /// `/v2/scrape` job.
    Scrape,
    /// `/v2/parse` job.
    Parse,
    /// `/v2/map` job.
    Map,
}

/// A single source the user considered valuable (for `good` / `partial`).
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackValuableSource {
    /// The URL of the valuable source.
    pub url: String,
    /// Optional reason the source was valuable.
    pub reason: Option<String>,
}

/// A topic the user expected but did not find in the result.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackMissingContent {
    /// Topic that was missing.
    pub topic: String,
    /// Optional description of the gap.
    pub description: Option<String>,
}

/// Request body for `POST /v2/search/:jobId/feedback`.
///
/// Mirrors the JS SDK `SearchFeedbackRequest`.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchFeedbackRequest {
    /// The qualitative rating for the search result.
    pub rating: FeedbackRating,

    /// Sources the user considered valuable.
    pub valuable_sources: Option<Vec<FeedbackValuableSource>>,

    /// Topics the user expected but did not find.
    pub missing_content: Option<Vec<FeedbackMissingContent>>,

    /// Free-form suggestions for improving the query.
    pub query_suggestions: Option<String>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,

    /// Origin label for request attribution (e.g., "rust-sdk@2.9.0").
    pub origin: Option<String>,
}

impl Default for SearchFeedbackRequest {
    fn default() -> Self {
        Self {
            rating: FeedbackRating::Good,
            valuable_sources: None,
            missing_content: None,
            query_suggestions: None,
            integration: None,
            origin: None,
        }
    }
}

/// Request body for `POST /v2/feedback`.
///
/// Mirrors the JS SDK `EndpointFeedbackRequest`, which extends
/// `SearchFeedbackRequest` with endpoint / jobId-specific fields.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EndpointFeedbackRequest {
    /// The endpoint the job came from.
    pub endpoint: FeedbackEndpoint,

    /// The job id returned by the originating endpoint.
    pub job_id: String,

    /// The qualitative rating for the result.
    pub rating: FeedbackRating,

    /// Issue codes describing what went wrong (max 20).
    pub issues: Option<Vec<String>>,

    /// Tag codes describing the result (max 20).
    pub tags: Option<Vec<String>>,

    /// Free-form note about the feedback.
    pub note: Option<String>,

    /// Sources the user considered valuable.
    pub valuable_sources: Option<Vec<FeedbackValuableSource>>,

    /// Topics the user expected but did not find.
    pub missing_content: Option<Vec<FeedbackMissingContent>>,

    /// Free-form suggestions for improving the query.
    pub query_suggestions: Option<String>,

    /// URL the feedback refers to (where applicable).
    pub url: Option<String>,

    /// Page numbers (for paginated / document jobs).
    pub page_numbers: Option<Vec<u32>>,

    /// Small endpoint-specific metadata object. Must be 8KB or smaller.
    pub metadata: Option<HashMap<String, Value>>,

    /// Origin label for request attribution (e.g., "rust-sdk@2.9.0").
    pub origin: Option<String>,

    /// Integration identifier for tracking.
    pub integration: Option<String>,
}

impl Default for EndpointFeedbackRequest {
    fn default() -> Self {
        Self {
            endpoint: FeedbackEndpoint::Scrape,
            job_id: String::new(),
            rating: FeedbackRating::Bad,
            issues: None,
            tags: None,
            note: None,
            valuable_sources: None,
            missing_content: None,
            query_suggestions: None,
            url: None,
            page_numbers: None,
            metadata: None,
            origin: None,
            integration: None,
        }
    }
}

/// Response from a feedback submission.
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackResponse {
    /// Always `true` for a successful feedback submission.
    pub success: bool,
    /// Identifier of the recorded feedback.
    pub feedback_id: String,
    /// Credits refunded for this submission.
    pub credits_refunded: i64,
    /// `true` if feedback for this job was already on record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_submitted: Option<bool>,
    /// `true` if the daily refund cap has been reached.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_cap_reached: Option<bool>,
    /// Credits refunded today so far.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits_refunded_today: Option<i64>,
    /// Daily refund cap configured for the team.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daily_refund_cap: Option<i64>,
    /// Optional warning from the server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

impl Client {
    /// Submits feedback for a v2 job (scrape, search, parse, or map).
    ///
    /// Hits `POST /v2/feedback`. Returns the recorded feedback id and
    /// refund details.
    ///
    /// # Arguments
    ///
    /// * `request` - Feedback payload (endpoint, job id, rating, supporting signals).
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::{Client, EndpointFeedbackRequest, FeedbackEndpoint, FeedbackRating};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///     let response = client.feedback(EndpointFeedbackRequest {
    ///         endpoint: FeedbackEndpoint::Scrape,
    ///         job_id: "job-123".to_string(),
    ///         rating: FeedbackRating::Bad,
    ///         note: Some("Returned a paywall page".to_string()),
    ///         ..Default::default()
    ///     }).await?;
    ///     println!("Recorded feedback {} (refunded {} credits)", response.feedback_id, response.credits_refunded);
    ///     Ok(())
    /// }
    /// ```
    pub async fn feedback(
        &self,
        mut request: EndpointFeedbackRequest,
    ) -> Result<FeedbackResponse, FirecrawlError> {
        if request.origin.is_none() {
            request.origin = Some(format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")));
        }

        let response = self
            .client
            .post(self.url("/feedback"))
            .headers(self.prepare_headers(None))
            .json(&request)
            .send()
            .await
            .map_err(|e| FirecrawlError::HttpError("Submitting feedback".to_string(), e))?;

        self.handle_response(response, "feedback").await
    }

    /// Submits feedback for a search job.
    ///
    /// Hits `POST /v2/search/:jobId/feedback`. Returns the recorded feedback
    /// id and refund details.
    ///
    /// # Arguments
    ///
    /// * `job_id` - Search job id returned by [`Client::search`].
    /// * `request` - Search feedback payload (rating + supporting signals).
    ///
    /// # Example
    ///
    /// ```no_run
    /// use firecrawl::{Client, FeedbackRating, SearchFeedbackRequest};
    ///
    /// #[tokio::main]
    /// async fn main() -> Result<(), Box<dyn std::error::Error>> {
    ///     let client = Client::new("your-api-key")?;
    ///     let response = client.search_feedback(
    ///         "search-job-123",
    ///         SearchFeedbackRequest {
    ///             rating: FeedbackRating::Good,
    ///             ..Default::default()
    ///         },
    ///     ).await?;
    ///     println!("Recorded search feedback {}", response.feedback_id);
    ///     Ok(())
    /// }
    /// ```
    pub async fn search_feedback(
        &self,
        job_id: impl AsRef<str>,
        mut request: SearchFeedbackRequest,
    ) -> Result<FeedbackResponse, FirecrawlError> {
        if request.origin.is_none() {
            request.origin = Some(format!("rust-sdk@{}", env!("CARGO_PKG_VERSION")));
        }

        let path = format!("/search/{}/feedback", job_id.as_ref());
        let response = self
            .client
            .post(self.url(&path))
            .headers(self.prepare_headers(None))
            .json(&request)
            .send()
            .await
            .map_err(|e| {
                FirecrawlError::HttpError(
                    format!("Submitting search feedback for {}", job_id.as_ref()),
                    e,
                )
            })?;

        self.handle_response(response, "search feedback").await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_endpoint_feedback_request_serializes_camel_case() {
        let request = EndpointFeedbackRequest {
            endpoint: FeedbackEndpoint::Scrape,
            job_id: "job-abc".to_string(),
            rating: FeedbackRating::Bad,
            issues: Some(vec!["paywall".to_string()]),
            tags: Some(vec!["broken".to_string()]),
            note: Some("Returned a paywall page".to_string()),
            valuable_sources: Some(vec![FeedbackValuableSource {
                url: "https://example.com/real".to_string(),
                reason: Some("Was the real article".to_string()),
            }]),
            missing_content: Some(vec![FeedbackMissingContent {
                topic: "Pricing".to_string(),
                description: Some("Could not find pricing".to_string()),
            }]),
            query_suggestions: None,
            url: Some("https://example.com/blog/post-1".to_string()),
            page_numbers: Some(vec![1, 2, 3]),
            metadata: Some(HashMap::from([(
                "trace_id".to_string(),
                Value::String("trace-123".to_string()),
            )])),
            origin: Some("rust-sdk@test".to_string()),
            integration: None,
        };

        let payload = serde_json::to_value(&request).unwrap();
        assert_eq!(payload["endpoint"], "scrape");
        assert_eq!(payload["jobId"], "job-abc");
        assert_eq!(payload["rating"], "bad");
        assert_eq!(payload["issues"][0], "paywall");
        assert_eq!(payload["tags"][0], "broken");
        assert_eq!(payload["note"], "Returned a paywall page");
        assert_eq!(payload["valuableSources"][0]["url"], "https://example.com/real");
        assert_eq!(payload["missingContent"][0]["topic"], "Pricing");
        assert_eq!(payload["url"], "https://example.com/blog/post-1");
        assert_eq!(payload["pageNumbers"], json!([1, 2, 3]));
        assert_eq!(payload["metadata"]["trace_id"], "trace-123");
        assert_eq!(payload["origin"], "rust-sdk@test");
    }

    #[test]
    fn test_search_feedback_request_serializes_camel_case() {
        let request = SearchFeedbackRequest {
            rating: FeedbackRating::Good,
            valuable_sources: Some(vec![FeedbackValuableSource {
                url: "https://example.com/result".to_string(),
                reason: None,
            }]),
            missing_content: None,
            query_suggestions: Some("Try a different phrasing".to_string()),
            integration: Some("test-integration".to_string()),
            origin: Some("rust-sdk@test".to_string()),
        };

        let payload = serde_json::to_value(&request).unwrap();
        assert_eq!(payload["rating"], "good");
        assert_eq!(payload["valuableSources"][0]["url"], "https://example.com/result");
        assert!(payload["valuableSources"][0].get("reason").is_none());
        assert_eq!(
            payload["querySuggestions"],
            "Try a different phrasing"
        );
        assert_eq!(payload["integration"], "test-integration");
        assert_eq!(payload["origin"], "rust-sdk@test");
    }

    #[tokio::test]
    async fn test_feedback_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/feedback")
            .with_status(200)
            .with_header("content-type", "application/json")
            .match_body(mockito::Matcher::Json(json!({
                "endpoint": "scrape",
                "jobId": "scrape-job-1",
                "rating": "bad",
                "note": "Returned a paywall page",
                "origin": "rust-sdk@test"
            })))
            .with_body(
                json!({
                    "success": true,
                    "feedbackId": "fb-1",
                    "creditsRefunded": 1,
                    "warning": null
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client
            .feedback(EndpointFeedbackRequest {
                endpoint: FeedbackEndpoint::Scrape,
                job_id: "scrape-job-1".to_string(),
                rating: FeedbackRating::Bad,
                note: Some("Returned a paywall page".to_string()),
                origin: Some("rust-sdk@test".to_string()),
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.success);
        assert_eq!(response.feedback_id, "fb-1");
        assert_eq!(response.credits_refunded, 1);
        mock.assert();
    }

    #[tokio::test]
    async fn test_feedback_sets_default_origin() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/feedback")
            .with_status(200)
            .with_header("content-type", "application/json")
            .match_body(mockito::Matcher::PartialJson(json!({
                "endpoint": "parse",
                "jobId": "parse-job-1",
                "rating": "partial",
                "origin": format!("rust-sdk@{}", env!("CARGO_PKG_VERSION"))
            })))
            .with_body(
                json!({
                    "success": true,
                    "feedbackId": "fb-2",
                    "creditsRefunded": 0
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client
            .feedback(EndpointFeedbackRequest {
                endpoint: FeedbackEndpoint::Parse,
                job_id: "parse-job-1".to_string(),
                rating: FeedbackRating::Partial,
                ..Default::default()
            })
            .await
            .unwrap();

        assert!(response.success);
        assert_eq!(response.feedback_id, "fb-2");
        mock.assert();
    }

    #[tokio::test]
    async fn test_search_feedback_with_mock() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/search/search-job-7/feedback")
            .with_status(200)
            .with_header("content-type", "application/json")
            .match_body(mockito::Matcher::Json(json!({
                "rating": "good",
                "valuableSources": [
                    {
                        "url": "https://example.com/result"
                    }
                ],
                "origin": "rust-sdk@test"
            })))
            .with_body(
                json!({
                    "success": true,
                    "feedbackId": "fb-search-1",
                    "creditsRefunded": 0,
                    "alreadySubmitted": false
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let response = client
            .search_feedback(
                "search-job-7",
                SearchFeedbackRequest {
                    rating: FeedbackRating::Good,
                    valuable_sources: Some(vec![FeedbackValuableSource {
                        url: "https://example.com/result".to_string(),
                        reason: None,
                    }]),
                    origin: Some("rust-sdk@test".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert!(response.success);
        assert_eq!(response.feedback_id, "fb-search-1");
        assert_eq!(response.already_submitted, Some(false));
        mock.assert();
    }

    #[tokio::test]
    async fn test_feedback_error_response() {
        let mut server = mockito::Server::new_async().await;

        let mock = server
            .mock("POST", "/v2/feedback")
            .with_status(400)
            .with_header("content-type", "application/json")
            .with_body(
                json!({
                    "success": false,
                    "error": "Feedback must include at least one substantive signal"
                })
                .to_string(),
            )
            .create();

        let client = Client::new_selfhosted(server.url(), Some("test_key")).unwrap();
        let result = client
            .feedback(EndpointFeedbackRequest {
                endpoint: FeedbackEndpoint::Scrape,
                job_id: "scrape-job-2".to_string(),
                rating: FeedbackRating::Bad,
                ..Default::default()
            })
            .await;

        assert!(result.is_err());
        mock.assert();
    }
}
