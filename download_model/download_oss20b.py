from huggingface_hub import snapshot_download

snapshot_download(
    repo_id="unsloth/gpt-oss-20b-GGUF",
    local_dir="/Users/yapweijun/models/unsloth-gpt-oss-20b-GGUF",
    allow_patterns=["*Q4_K_M*"],
)
