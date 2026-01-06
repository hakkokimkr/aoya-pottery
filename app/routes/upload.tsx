import type { Route } from "./+types/upload";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useState, useRef, useEffect } from "react";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Upload Photos - Aoya Pottery" },
    { name: "description", content: "Upload and manage photos" },
  ];
}

export async function loader({ context }: Route.LoaderArgs) {
  const db = context.cloudflare.env.DB;

  try {
    const result = await db
      .prepare(
        "SELECT id, filename, url, size, uploaded_at FROM files ORDER BY uploaded_at DESC"
      )
      .all();

    return {
      files: result.results || [],
    };
  } catch (error) {
    console.error("Error loading files:", error);
    return {
      files: [],
    };
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Helper to return JSON response
  const jsonResponse = (
    data: { success: boolean; message?: string },
    status = 200
  ) => {
    return Response.json(data, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };

  if (intent === "delete") {
    const fileId = formData.get("id") as string;
    const filename = formData.get("filename") as string;

    try {
      // Delete from R2
      const { S3Client, DeleteObjectCommand } =
        await import("@aws-sdk/client-s3");
      const s3Client = new S3Client({
        region: "auto",
        endpoint:
          "https://f668dfa8580d3ffda32d5ca87213d141.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: context.cloudflare.env.S3_ACCESS_KEY_ID,
          secretAccessKey: context.cloudflare.env.S3_SECRET_ACCESS_KEY,
        },
      });

      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: "aoya-pottery",
          Key: filename,
        })
      );

      // Delete from D1
      const db = context.cloudflare.env.DB;
      await db.prepare("DELETE FROM files WHERE id = ?").bind(fileId).run();

      return jsonResponse({
        success: true,
        message: "File deleted successfully",
      });
    } catch (error) {
      console.error("Error deleting file:", error);
      return jsonResponse(
        { success: false, message: "Failed to delete file" },
        500
      );
    }
  }

  if (intent === "upload") {
    const file = formData.get("file") as File;

    if (!file) {
      return jsonResponse({ success: false, message: "No file provided" }, 400);
    }

    try {
      // Upload to R2
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const s3Client = new S3Client({
        region: "auto",
        endpoint:
          "https://f668dfa8580d3ffda32d5ca87213d141.r2.cloudflarestorage.com",
        credentials: {
          accessKeyId: context.cloudflare.env.S3_ACCESS_KEY_ID,
          secretAccessKey: context.cloudflare.env.S3_SECRET_ACCESS_KEY,
        },
      });

      const db = context.cloudflare.env.DB;

      // Get existing filenames to check for duplicates
      const existingFilesResult = await db
        .prepare("SELECT filename FROM files")
        .all();
      const existingFilenames = new Set(
        (existingFilesResult.results || []).map((f: any) => f.filename)
      );

      // Process image with @cf-wasm/photon: resize and optimize
      const { PhotonImage, SamplingFilter, resize } =
        await import("@cf-wasm/photon/workerd");
      const fileBuffer = await file.arrayBuffer();
      const inputBytes = new Uint8Array(fileBuffer);

      // Create PhotonImage instance
      const inputImage = PhotonImage.new_from_byteslice(inputBytes);

      // Resize image to smaller size for web (max width 1920px, maintain aspect ratio)
      const maxWidth = 1920;
      let outputImage: typeof inputImage;
      let needsResize = inputImage.get_width() > maxWidth;

      if (needsResize) {
        const aspectRatio = inputImage.get_height() / inputImage.get_width();
        const newHeight = Math.round(maxWidth * aspectRatio);
        outputImage = resize(
          inputImage,
          maxWidth,
          newHeight,
          SamplingFilter.Lanczos3
        );
      } else {
        // No resize needed, use input image directly
        outputImage = inputImage;
      }

      // Convert to JPEG format with quality 75 for good balance
      const optimizedBuffer = outputImage.get_bytes_jpeg(75);
      const contentType = "image/jpeg";

      // Free memory (only free outputImage if it was resized, otherwise it's the same as inputImage)
      if (needsResize) {
        outputImage.free();
      }
      inputImage.free();

      // Generate filename with .jpg extension (optimized format)
      const originalName = file.name;
      const lastDotIndex = originalName.lastIndexOf(".");
      const nameWithoutExt =
        lastDotIndex > 0
          ? originalName.substring(0, lastDotIndex)
          : originalName;
      let filename = `${nameWithoutExt}.jpg`;

      // Check if filename already exists, if so, add timestamp before extension
      if (existingFilenames.has(filename)) {
        const timestamp = Date.now();
        filename = `${nameWithoutExt}-${timestamp}.jpg`;
      }

      // Add to set to prevent duplicates within the same upload batch
      existingFilenames.add(filename);

      // Upload to R2
      await s3Client.send(
        new PutObjectCommand({
          Bucket: "aoya-pottery",
          Key: filename,
          Body: optimizedBuffer,
          ContentType: contentType,
          ACL: "public-read",
        })
      );

      // Save metadata to D1
      const url = `https://asset.aoya-pottery.com/${filename}`;

      await db
        .prepare(
          "INSERT INTO files (id, filename, url, size, content_type, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(
          crypto.randomUUID(),
          filename,
          url,
          optimizedBuffer.length,
          contentType,
          new Date().toISOString()
        )
        .run();

      return jsonResponse({
        success: true,
        message: "File uploaded successfully",
      });
    } catch (error) {
      console.error("Error uploading files:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Failed to upload file";
      return jsonResponse(
        {
          success: false,
          message: errorMessage,
        },
        500
      );
    }
  }

  return jsonResponse({ success: false, message: "Invalid action" }, 400);
}

type UploadStatus = {
  file: File;
  status: "pending" | "uploading" | "success" | "error";
  message?: string;
};

export default function Upload({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { files } = useLoaderData<typeof loader>();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [uploadStatuses, setUploadStatuses] = useState<
    Map<number, UploadStatus>
  >(new Map());
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const handleFiles = (fileList: FileList | null) => {
    if (fileList) {
      const newFiles = Array.from(fileList);
      setSelectedFiles((prev) => {
        // Merge with existing files, avoiding duplicates by name
        const existingNames = new Set(prev.map((f) => f.name));
        const uniqueNewFiles = newFiles.filter(
          (f) => !existingNames.has(f.name)
        );
        return [...prev, ...uniqueNewFiles];
      });
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const droppedFiles = e.dataTransfer.files;
    if (droppedFiles.length > 0) {
      handleFiles(droppedFiles);
    }
  };

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Upload each file individually using fetchers
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (selectedFiles.length === 0) return;

    // Initialize upload statuses
    const initialStatuses = new Map<number, UploadStatus>();
    selectedFiles.forEach((file, index) => {
      initialStatuses.set(index, { file, status: "pending" });
    });
    setUploadStatuses(initialStatuses);

    // Upload each file individually using Promise.all for parallel uploads
    const uploadPromises = selectedFiles.map(async (file, i) => {
      // Update status to uploading
      setUploadStatuses((prev) => {
        const newMap = new Map(prev);
        newMap.set(i, { file, status: "uploading" });
        return newMap;
      });

      try {
        const formData = new FormData();
        formData.append("intent", "upload");
        formData.append("file", file);

        // Upload file - don't expect JSON response
        const response = await fetch(window.location.pathname, {
          method: "POST",
          body: formData,
        });

        // If response is OK (200-299), consider it successful
        // React Router might return HTML, but if status is OK, upload likely succeeded
        if (response.ok) {
          setUploadStatuses((prev) => {
            const newMap = new Map(prev);
            newMap.set(i, {
              file,
              status: "success",
              message: "File uploaded successfully",
            });
            return newMap;
          });
        } else {
          // HTTP error - get error message if possible
          let errorMessage = `Upload failed: HTTP ${response.status}`;
          try {
            const errorText = await response.text();
            // Try to extract error message from HTML if present
            const errorMatch = errorText.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (errorMatch) {
              errorMessage = errorMatch[1];
            }
          } catch (e) {
            // Ignore parsing errors
          }

          setUploadStatuses((prev) => {
            const newMap = new Map(prev);
            newMap.set(i, {
              file,
              status: "error",
              message: errorMessage,
            });
            return newMap;
          });
        }
      } catch (error) {
        console.error(`Error uploading ${file.name}:`, error);
        const errorMessage =
          error instanceof Error ? error.message : "Upload failed";
        setUploadStatuses((prev) => {
          const newMap = new Map(prev);
          newMap.set(i, {
            file,
            status: "error",
            message: errorMessage,
          });
          return newMap;
        });
      }
    });

    // Wait for all uploads to complete
    await Promise.all(uploadPromises);

    // Reload file list after all uploads complete
    setTimeout(() => {
      window.location.reload();
    }, 1500);
  };

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Photo Upload</h1>

        {/* Upload Form */}
        <div className="bg-white rounded-lg shadow-md p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Upload Photos</h2>
          <Form
            method="post"
            encType="multipart/form-data"
            onSubmit={handleSubmit}
          >
            <div className="mb-4">
              {/* Drag and Drop Zone */}
              <div
                ref={dropZoneRef}
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  isDragging
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-300 hover:border-gray-400"
                }`}
              >
                <div className="space-y-2">
                  <svg
                    className="mx-auto h-12 w-12 text-gray-400"
                    stroke="currentColor"
                    fill="none"
                    viewBox="0 0 48 48"
                    aria-hidden="true"
                  >
                    <path
                      d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02"
                      strokeWidth={2}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <div className="text-sm text-gray-600">
                    <label
                      htmlFor="file"
                      className="relative cursor-pointer rounded-md font-medium text-blue-600 focus-within:outline-none focus-within:ring-2 focus-within:ring-blue-500 focus-within:ring-offset-2"
                    >
                      <span>Click to select</span>
                      <input
                        ref={fileInputRef}
                        type="file"
                        id="file"
                        name="file"
                        accept="image/*"
                        multiple
                        onChange={(e) => {
                          handleFiles(e.target.files);
                          // Reset input to allow selecting the same file again
                          if (e.target) {
                            (e.target as HTMLInputElement).value = "";
                          }
                        }}
                        className="sr-only"
                      />
                    </label>
                    <span className="pl-1">or drag and drop</span>
                  </div>
                  <p className="text-xs text-gray-500">
                    PNG, JPG, GIF up to 10MB each
                  </p>
                </div>
              </div>

              {selectedFiles.length > 0 && (
                <div className="mt-4 p-4 bg-gray-50 rounded-md">
                  <p className="text-sm font-medium text-gray-700 mb-3">
                    Selected {selectedFiles.length} file(s):
                  </p>
                  <ul className="space-y-2 max-h-60 overflow-y-auto">
                    {selectedFiles.map((file, index) => {
                      const status = uploadStatuses.get(index);
                      const statusColor =
                        status?.status === "success"
                          ? "text-green-600"
                          : status?.status === "error"
                            ? "text-red-600"
                            : status?.status === "uploading"
                              ? "text-blue-600"
                              : "text-gray-500";
                      return (
                        <li
                          key={index}
                          className="flex items-center justify-between p-2 bg-white rounded border border-gray-200"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-900 truncate">
                              {file.name}
                            </p>
                            <p className="text-xs text-gray-500">
                              {(file.size / 1024 / 1024).toFixed(2)} MB
                            </p>
                            {status && (
                              <p className={`text-xs mt-1 ${statusColor}`}>
                                {status.status === "uploading" &&
                                  "⏳ Uploading..."}
                                {status.status === "success" &&
                                  "✅ " + (status.message || "Uploaded")}
                                {status.status === "error" &&
                                  "❌ " + (status.message || "Failed")}
                                {status.status === "pending" && "⏸ Pending..."}
                              </p>
                            )}
                          </div>
                          {!status || status.status !== "uploading" ? (
                            <button
                              type="button"
                              onClick={() => removeFile(index)}
                              className="ml-2 text-red-600 hover:text-red-800 text-sm font-medium"
                            >
                              Remove
                            </button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="text-xs text-gray-500 mt-3">
                    Total size:{" "}
                    {(
                      selectedFiles.reduce((sum, f) => sum + f.size, 0) /
                      1024 /
                      1024
                    ).toFixed(2)}{" "}
                    MB
                  </p>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={
                selectedFiles.length === 0 ||
                Array.from(uploadStatuses.values()).some(
                  (s) => s.status === "uploading"
                )
              }
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {Array.from(uploadStatuses.values()).some(
                (s) => s.status === "uploading"
              )
                ? "Uploading..."
                : `Upload ${selectedFiles.length || ""} Photo${selectedFiles.length !== 1 ? "s" : ""}`}
            </button>
          </Form>
        </div>

        {/* Files List */}
        <div className="bg-white rounded-lg shadow-md p-6">
          <h2 className="text-xl font-semibold mb-4">Uploaded Photos</h2>
          {files.length === 0 ? (
            <p className="text-gray-500">No photos uploaded yet.</p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {files.map((file: any) => (
                <div
                  key={file.id}
                  className="border rounded-lg overflow-hidden shadow-sm hover:shadow-md transition-shadow"
                >
                  <div className="aspect-square bg-gray-100 relative">
                    <img
                      src={file.url}
                      alt={file.filename}
                      className="w-full h-full object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).src =
                          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23ddd' width='100' height='100'/%3E%3Ctext fill='%23999' font-family='sans-serif' font-size='14' dy='10.5' x='50%25' y='50%25' text-anchor='middle'%3ENo Image%3C/text%3E%3C/svg%3E";
                      }}
                    />
                  </div>
                  <div className="p-4">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {file.filename}
                    </p>
                    <p className="text-xs text-gray-500 mt-1">
                      {(file.size / 1024).toFixed(2)} KB
                    </p>
                    <p className="text-xs text-gray-400 mt-1">
                      {new Date(file.uploaded_at).toLocaleDateString()}
                    </p>
                    <Form method="post" className="mt-3">
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={file.id} />
                      <input
                        type="hidden"
                        name="filename"
                        value={file.filename}
                      />
                      <button
                        type="submit"
                        className="w-full px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700"
                      >
                        Delete
                      </button>
                    </Form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
