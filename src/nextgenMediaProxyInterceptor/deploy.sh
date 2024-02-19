#!/bin/bash

set -e

distribution_id="E1RI37JRN0ZK6J"
function_name="nextgenMediaProxyInterceptor"
region="us-east-1"

echo "Uploading new code to $function_name"
aws lambda update-function-code --function-name "${function_name}" --zip-file fileb://dist/index.zip --region="${region}" > /dev/null
sleep 10
echo "New code uploaded to $function_name"
echo "Publishing new version of $function_name"
aws lambda publish-version --function-name "${function_name}" --description "$(date) - $(git rev-parse --abbrev-ref HEAD) - $(git show -s --format=%s)" --region="${region}" > /dev/null
sleep 10
echo "New version of $function_name published"

readonly lambda_arn=$(
  aws lambda list-versions-by-function \
    --function-name "$function_name" \
    --region "$region" \
    --query "max_by(Versions, &to_number(to_number(Version) || '0'))" \
  | jq -r '.FunctionArn'
)
echo "Changing trigger to work on ARN $lambda_arn"

readonly tmp1=$(mktemp)
readonly tmp2=$(mktemp)

aws cloudfront get-distribution-config \
  --id "$distribution_id" \
> "$tmp1"

readonly etag=$(jq -r '.ETag' < "$tmp1")

cat "$tmp1" \
| jq '(.DistributionConfig.CacheBehaviors.Items[] | select(.PathPattern=="/mainnet/metadata/*" or .PathPattern=="/testnet/metadata/*") | .LambdaFunctionAssociations.Items[] | .LambdaFunctionARN ) |= "'"$lambda_arn"'"' \
| jq '.DistributionConfig' \
> "$tmp2"

aws cloudfront update-distribution \
  --id "$distribution_id" \
  --distribution-config "file://$tmp2" \
  --if-match "$etag" > /dev/null

echo "Trigger changed to work on ARN $lambda_arn"

echo "Cleaning up"
rm -f "$tmp1" "$tmp2"
echo "Successfully deployed $lambda_arn"