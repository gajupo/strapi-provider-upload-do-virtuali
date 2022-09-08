"use strict";
const AWS = require("aws-sdk");
const URI = require("urijs");
const crypto = require("crypto");
const { S3ReadStream } = require("s3-readstream-virtuali");
class FileLocationConverter {
  constructor(config) {
    this.config = config;
  }

  getKey(file) {
    // generate init filename
    let filename = `${file.hash}${file.ext}`;
    // the file name is composed as mianfolder_subfolder_filename and so on
    // validate if the file name has at least two _ in the name
    if (file.name.split("_").length > 2) {
      // get main folder name from file name by _
      const mainFolder = file.name.split("_")[0];
      // get subfolder name from file name by _
      const subFolder = file.name.split("_")[1];
      // validates if config.folder is defined
      if (this.config.folders) {
        // if folder exists in [{folderName: 'folder', acl: 'key'}]
        const folderConfig = this.config.folders.find(
          (f) => f.folderName === mainFolder
        );
        if (folderConfig) {
          return `${folderConfig.folderName}/${subFolder}/${filename}`;
        }
      }
    }
    if (!this.config.directory) return filename;
    return `${this.config.directory}/${filename}`;
  }

  getUrl(data) {
    if (!this.config.cdn) return data.Location;
    var parts = {};
    URI.parseHost(this.config.cdn, parts);
    parts.protocol = "https"; // Force https
    parts.path = data.Key;
    return URI.build(parts);
  }
  getACL(file) {
    if (!this.config.acl) return "public-read";
    const folder = file.name.split("_")[0];
    const folderConfig = this.config.folders.find(
      (f) => f.folderName === folder
    );
    if (folderConfig) {
      return folderConfig.acl;
    }
    return this.config.acl;
  }
  getObjectHeaders(file, s3) {
    return new Promise((resolve, reject) => {
      const params = {
        Key: this.getKey(file),
      };
      s3.headObject(params, (err, data) => {
        if (err) {
          return reject(err);
        }
        return resolve(data);
      });
    });
  }
}

module.exports = {
  provider: "do",
  name: "Digital Ocean Spaces",
  auth: {
    key: {
      label: "Key",
      type: "text",
    },
    secret: {
      label: "Secret",
      type: "text",
    },
    endpoint: {
      label: "Endpoint (e.g. 'fra1.digitaloceanspaces.com')",
      type: "text",
    },
    cdn: {
      label: "CDN Endpoint (Optional - e.g. 'https://cdn.space.com')",
      type: "text",
    },
    space: {
      label: "Space (e.g. myspace)",
      type: "text",
    },
    directory: {
      label:
        "Directory (Optional - e.g. directory - place when you want to save files)",
      type: "text",
    },
  },
  init: (config) => {
    const endpoint = new AWS.Endpoint(config.endpoint);
    const converter = new FileLocationConverter(config);

    const S3 = new AWS.S3({
      endpoint: endpoint,
      accessKeyId: config.key,
      secretAccessKey: config.secret,
      params: {
        Bucket: config.space,
        CacheControl: "public, max-age=31536000, immutable",
      },
    });

    const upload = (file, customParams = {}) =>
      new Promise((resolve, reject) => {
        //--- Compute the file key.
        file.hash = crypto.createHash("md5").update(file.hash).digest("hex");

        //--- Upload the file into the space (technically the S3 Bucket)
        S3.upload(
          {
            ACL: converter.getACL(file),
            Key: converter.getKey(file),
            Body: file.stream || Buffer.from(file.buffer, "binary"),
            ContentType: file.mime,
            ...customParams,
          },

          //--- Callback handler
          (err, data) => {
            if (err) return reject(err);
            file.url = converter.getUrl(data);
            resolve(data);
          }
        );
      });

    return {
      uploadStream(file, customParams = {}) {
        return upload(file, customParams);
      },
      
      upload(file, customParams = {}) {
        return upload(file, customParams);
      },

      delete: (file) => {
        return new Promise((resolve, reject) => {
          //--- Delete the file from the space
          S3.deleteObject(
            {
              Bucket: config.space,
              Key: converter.getKey(file),
            },

            //--- Callback handler
            (err, data) => {
              if (err) return reject(err);
              else resolve();
            }
          );
        })
      },
      getReadStream: async (file, byteRange, currentCursorPosition) => {
          //--- Download the file from the space
          try {
            // promesify s3.headObject
            const bucketParams = {
              Bucket: config.space,
              Key: converter.getKey(file),
            };
            // get file info
            const fileInfo = await converter.getObjectHeaders(file, S3);
            // if byteRange is defined and greater than 0 then set range
            // else set byteRange to 5MB
            const options = {
              parameters: bucketParams,
              s3: S3,
              maxLength: fileInfo.ContentLength,
              byteRange: (byteRange && byteRange > 0) ? byteRange : 1024 * 1024 * 5,
              currentCursorPos: currentCursorPosition,
            };

            return new S3ReadStream(options);

          } catch (error) {
            console.error(error);
          }
      },
      getFileInfo: async (fileInfo) => {
        try {
          // get file info
          return await converter.getObjectHeaders(fileInfo, S3);
        } catch (error) {
          console.error(error);
        }
      }
    };
  },
};